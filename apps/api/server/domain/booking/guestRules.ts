import type { AgeGroup, BookingType, Gender, Occupancy } from '@hajj/contracts/constants/booking'
import type { IsoDate } from '@hajj/contracts/utils/dates'

export interface AgeLimits { childAgeLimit: number, infantAgeLimit: number }

const parts = (date: IsoDate) => date.split('-').map(Number) as [number, number, number]

/** Whole years on `day` (a 29 February birthday counts from 1 March in other years). */
export function ageOn(dateOfBirth: IsoDate, day: IsoDate): number {
  const [by, bm, bd] = parts(dateOfBirth)
  const [dy, dm, dd] = parts(day)
  return dy - by - (dm < bm || (dm === bm && dd < bd) ? 1 : 0)
}

/** v7 §7: never chosen by hand — from the date of birth on the check-in day (CHILD under the child age, INFANT under the infant age). */
export function ageGroupFor(dateOfBirth: IsoDate, checkIn: IsoDate, limits: AgeLimits): AgeGroup {
  const age = ageOn(dateOfBirth, checkIn)
  return age < limits.infantAgeLimit ? 'INFANT' : age < limits.childAgeLimit ? 'CHILD' : 'ADULT'
}

/** `date` plus whole months, the day kept or clamped to the month's end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = parts(date)
  const index = y * 12 + (m - 1) + months
  const year = Math.floor(index / 12)
  const month = index % 12 + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`
}

/** The fields a slot needs before check-in (v7 §7 "READY"). */
export interface GuestFacts {
  fullName: string
  gender?: Gender | null
  nationality?: string | null
  dateOfBirth?: IsoDate | null
  passportNo?: string | null
  passportExpiry?: IsoDate | null
}

export const isComplete = (details: GuestFacts): boolean =>
  Boolean(details.fullName && details.gender && details.nationality && details.dateOfBirth && details.passportNo && details.passportExpiry)

/** The slot as booked: its booking type, age group, and the side of the room it sleeps in. */
export interface SlotFacts { bookingType: BookingType, ageGroup: AgeGroup, occupancy: Occupancy | null, checkIn: IsoDate }

export type GuestIssueCode = 'GENDER_MISMATCH' | 'AGE_GROUP_MISMATCH' | 'IMPLAUSIBLE_DATE' | 'PASSPORT_EXPIRES_SOON'

/** The earliest date of birth accepted, and how far ahead a passport expiry may lie (passports run 5–10 years). */
const EARLIEST_BIRTH = '1900-01-01'
const MAX_PASSPORT_YEARS = 20

/** A blocking issue refuses the save (v7 §7: "the system blocks it and suggests another slot"); a warning is shown. */
export interface GuestIssue { code: GuestIssueCode, blocking: boolean }

/**
 * v7 §7, §13 — what a pilgrim's details mean for the slot: the age group the slot will have (from the date of birth
 * on the check-in day), and the issues. Blocking: a date of birth after check-in or before 1900, an expiry more than
 * 20 years after check-in; crossing the seat line either way — an infant slot (no seat) for someone older, or a
 * seated slot for an infant (an infant is not counted in the quota or the price, so details may never turn a seat
 * into one: the hotel changes the slot instead); in a GROUP, someone the child age or older on the other gender's
 * side (a boy of 11 booked as a child in the women's room counts the same). Warning: a passport valid for less than
 * `passportMinValidityMonths` after check-in. ADULT and CHILD may follow the date of birth (both take a seat).
 */
export function checkGuest(slot: SlotFacts, details: GuestFacts, settings: AgeLimits & { passportMinValidityMonths: number }): { ageGroup: AgeGroup, issues: GuestIssue[] } {
  const issues: GuestIssue[] = []
  const implausibleBirth = details.dateOfBirth && (details.dateOfBirth > slot.checkIn || details.dateOfBirth < EARLIEST_BIRTH)
  const implausibleExpiry = details.passportExpiry && details.passportExpiry > addMonths(slot.checkIn, MAX_PASSPORT_YEARS * 12)
  if (implausibleBirth || implausibleExpiry) issues.push({ code: 'IMPLAUSIBLE_DATE', blocking: true })
  const ageGroup = details.dateOfBirth && !implausibleBirth ? ageGroupFor(details.dateOfBirth, slot.checkIn, settings) : slot.ageGroup
  if ((slot.ageGroup === 'INFANT') !== (ageGroup === 'INFANT')) issues.push({ code: 'AGE_GROUP_MISMATCH', blocking: true })
  const side = slot.occupancy === 'MALE' || slot.occupancy === 'FEMALE' ? slot.occupancy : null
  if (slot.bookingType === 'GROUP' && side && details.gender && ageGroup === 'ADULT' && details.gender !== side) issues.push({ code: 'GENDER_MISMATCH', blocking: true })
  if (details.passportExpiry && details.passportExpiry < addMonths(slot.checkIn, settings.passportMinValidityMonths)) issues.push({ code: 'PASSPORT_EXPIRES_SOON', blocking: false })
  return { ageGroup, issues }
}

// What lists and the calendar show of a passport number: shared with the frontends (they must know a masked one).
export { maskPassport } from '@hajj/contracts/utils/passport'

/** The blind-index input of a passport (`passport_lookup`): nationality and number, so two countries' numbers never collide. */
export const passportLookupInput = (nationality: string, passportNo: string): string => `${nationality}|${passportNo}`

/** The blind-index context of `passport_lookup` (the same for the bookers' copies and the staff master, so they match). */
export const PASSPORT_LOOKUP_CONTEXT = 'passport_lookup'
