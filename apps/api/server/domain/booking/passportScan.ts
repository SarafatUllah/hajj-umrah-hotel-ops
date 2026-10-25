import type { AgeGroup, BookingType, Occupancy } from '@hajj/contracts/constants/booking'
import type { PassportScanFields, PassportScanMethod } from '@hajj/contracts/constants/pilgrimData'
import type { IsoDate } from '@hajj/contracts/utils/dates'
import { type AgeLimits, ageGroupFor } from './guestRules'
import type { MrzReading } from './mrz'

/** What a passport scan read: the review form's fields (the API contract's shape). */
export type ScanFields = PassportScanFields

export type ScanConfidence = Partial<Record<keyof ScanFields, number>>

export interface ScanResult { method: PassportScanMethod, fields: ScanFields, confidence: ScanConfidence }

/** Fields read with less confidence are highlighted on the review form (v7 §13 "suspicious fields in yellow"). */
export const REVIEW_THRESHOLD = 0.9

const CHECKED = 0.99
const UNCHECKED = 0.4
/** The MRZ name can be cut short (39 characters); the printed name is the full one. */
const MRZ_NAME = 0.8

/** An MRZ reading as review-form fields: check-digit-verified fields are trusted, a failed check is flagged. */
export function fromMrz(reading: MrzReading): ScanResult {
  const { fields, checks } = reading
  const nameTruncated = !reading.lines[0].endsWith('<')
  const fullName = [fields.givenNames, fields.surname].filter(Boolean).join(' ')
  return {
    method: 'MRZ',
    fields: {
      ...(fullName ? { fullName } : {}),
      ...(fields.sex ? { gender: fields.sex } : {}),
      nationality: fields.nationality,
      dateOfBirth: fields.dateOfBirth,
      passportNo: fields.passportNo,
      passportExpiry: fields.passportExpiry,
    },
    confidence: {
      fullName: nameTruncated ? UNCHECKED : MRZ_NAME,
      gender: checks.composite ? CHECKED : UNCHECKED,
      nationality: checks.composite ? CHECKED : UNCHECKED,
      dateOfBirth: checks.dateOfBirth ? CHECKED : UNCHECKED,
      passportNo: checks.passportNo ? CHECKED : UNCHECKED,
      passportExpiry: checks.passportExpiry ? CHECKED : UNCHECKED,
    },
  }
}

/**
 * The MRZ first (v7 §13), the AI fallback only where the MRZ is missing a field or read it below the review
 * threshold — and for the printed-page extras the MRZ never has. The method names what carried the reading.
 */
export function mergeReadings(mrz: ScanResult | null, ai: ScanResult | null): ScanResult | null {
  if (!mrz) return ai
  if (!ai) return mrz
  const keys = Object.keys(ai.fields) as Array<keyof ScanFields>
  const better = keys.filter(key => mrz.fields[key] === undefined || (mrz.confidence[key] ?? 0) < (ai.confidence[key] ?? 0))
  return {
    method: 'MRZ',
    fields: { ...mrz.fields, ...Object.fromEntries(better.map(key => [key, ai.fields[key]])) },
    confidence: { ...mrz.confidence, ...Object.fromEntries(better.map(key => [key, ai.confidence[key]])) },
  }
}

/** A slot a scan could fill: still waiting for details, and not already targeted by another scan. */
export interface OpenSlot { id: string, slotNo: number, ageGroup: AgeGroup, occupancy: Occupancy | null }

/**
 * v7 §13 step 3: where a scan goes when many are dropped at once — the first open slot of the same age group
 * (infants only into infant slots), in a GROUP on the side of the passport's gender (children may take either
 * side's slot); FAMILY slots take anyone. null = no fitting slot (the reviewer picks one).
 */
export function pickSlot(scan: Pick<ScanFields, 'gender' | 'dateOfBirth'>, slots: readonly OpenSlot[], stay: { bookingType: BookingType, checkIn: IsoDate }, limits: AgeLimits): string | null {
  const ageGroup: AgeGroup = scan.dateOfBirth ? ageGroupFor(scan.dateOfBirth, stay.checkIn, limits) : 'ADULT'
  const ordered = [...slots].sort((a, b) => a.slotNo - b.slotNo)
  if (ageGroup === 'INFANT') return ordered.find(s => s.ageGroup === 'INFANT')?.id ?? null
  const seated = ordered.filter(s => s.ageGroup !== 'INFANT')
  if (stay.bookingType === 'FAMILY') return seated[0]?.id ?? null
  if (ageGroup === 'CHILD') return (seated.find(s => s.ageGroup === 'CHILD') ?? seated[0])?.id ?? null
  if (!scan.gender) return null
  return (seated.find(s => s.occupancy === scan.gender && s.ageGroup === 'ADULT') ?? seated.find(s => s.occupancy === scan.gender))?.id ?? null
}
