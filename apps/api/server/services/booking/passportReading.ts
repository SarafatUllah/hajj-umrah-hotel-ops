import type { AgeGroup, BookingType, Occupancy } from '@hajj/contracts/constants/booking'
import { todayInTimezone } from '@hajj/contracts/utils/dates'
import { findMrzLines, parseMrz } from '../../domain/booking/mrz'
import { fromMrz, mergeReadings, pickSlot, type ScanResult } from '../../domain/booking/passportScan'
import { TooManyRequestsError } from '../../errors/domainError'
import { getPassportReaders, type PassportImage, type PassportVision } from '../../integrations/passportReaders'
import { bookingOrgRepos, tenantRepos } from '../../repositories'
import type { PassportScanRow } from '../../repositories/booking'
import { organizationScopeById } from '../../security/organizations'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import type { OrganizationScope } from '../../security/scope'
import { usePiiCipher } from '../../utils/pii'
import { loadBookingSettings } from './bookingSettingsService'
import { extractedContext, readStoredImage } from './passportImages'

type Db = Parameters<typeof bookingOrgRepos>[0]

/** The AI reader's fields sit below the review threshold: every one is checked by eye. */
const AI_CONFIDENCE = 0.6

interface Reading { result: ScanResult | null, failureReason: string | null }

/**
 * Whether this scan may go to the external AI reader now: within the organization's hourly budget (a paid call);
 * each sending is logged as a disclosure of the image (v7 §13 PDPL).
 */
async function mayDisclose(db: Db, scope: OrganizationScope, scanId: string, now: Date): Promise<boolean> {
  try {
    await consumeRateLimit(db, RATE_LIMITS.passportAiPerOrganization, scope.organizationId, now)
  }
  catch (error) {
    if (!(error instanceof TooManyRequestsError)) throw error
    console.error(`[passport] AI reading budget of organization ${scope.organizationId} reached: the scan goes to manual review`)
    return false
  }
  await bookingOrgRepos(db, scope).piiAccess.record([{ actorKind: 'system', actorId: null, subjectType: 'PASSPORT_SCAN', subjectId: scanId, fields: ['image'], purpose: 'sent to the external AI reader' }])
  return true
}

/** The MRZ on our own server first; the vision reader only when the MRZ is missing or fails a check, and `disclose` allows it. */
async function readImage(image: PassportImage, today: string, vision: PassportVision | null, disclose: () => Promise<boolean>): Promise<Reading> {
  const { ocr } = getPassportReaders()
  if (!ocr && !vision) return { result: null, failureReason: 'NO_READER' }
  const text = ocr ? await ocr.readText(image).catch((error: unknown) => { console.error('[passport] OCR failed:', error instanceof Error ? error.message : error); return null }) : null
  const lines = text ? findMrzLines(text) : null
  const mrz = lines ? parseMrz(lines, today) : null
  const verified = mrz && Object.values(mrz.checks).every(Boolean)
  const sendable = vision && image.bytes.length <= vision.maxImageBytes ? vision : null
  const visionFields = !verified && sendable && await disclose() ? await sendable.readFields(image) : null
  const read: ScanResult | null = visionFields && Object.keys(visionFields).length > 0
    ? { method: 'AI', fields: visionFields, confidence: Object.fromEntries(Object.keys(visionFields).map(k => [k, AI_CONFIDENCE])) }
    : null
  const result = mergeReadings(mrz ? fromMrz(mrz) : null, read)
  return { result, failureReason: result ? null : 'UNREADABLE' }
}

/** Reads a claimed scan and places it in an open slot of its booking (the passport's gender side in a GROUP). */
async function readAndPlace(db: Db, scope: OrganizationScope, scan: PassportScanRow, now: Date): Promise<void> {
  const repos = bookingOrgRepos(db, scope)
  const [booking, asset, settings] = await Promise.all([repos.records.findById(scan.bookingId), tenantRepos(db, scope).documentAssets.findById(scan.documentId), loadBookingSettings(db, scope)])
  if (!booking || !asset || asset.archivedAt) throw new Error('The scan lost its booking or image')
  const image: PassportImage = { bytes: await readStoredImage(asset.storageKey), mimeType: asset.mimeType as PassportImage['mimeType'] }
  const hotel = await tenantRepos(db, scope).hotels.findById(booking.hotelId)
  // The external reader only with the organization's consent (a cross-border transfer of personal data).
  const vision = settings.passportAiAllowed ? getPassportReaders().vision : null
  const { result, failureReason } = await readImage(image, todayInTimezone(hotel?.timezone ?? 'UTC', now), vision, () => mayDisclose(db, scope, scan.id, now))

  // The slot is a suggestion (two readings at once may suggest the same one); confirming checks the slot for real.
  const [slots, targeted] = await Promise.all([repos.guests.listForBooking(booking.id), repos.passportScans.targetedSlots(booking.id)])
  const open = slots
    .filter(s => s.guest.status === 'PENDING_DETAILS' && !s.detail && !targeted.includes(s.guest.id))
    .map(s => ({ id: s.guest.id, slotNo: s.guest.slotNo, ageGroup: s.guest.ageGroup as AgeGroup, occupancy: s.occupancy as Occupancy | null }))
  const guestId = result ? pickSlot(result.fields, open, { bookingType: booking.bookingType as BookingType, checkIn: booking.checkIn }, settings) : null
  await repos.passportScans.recordReading(scan.id, {
    status: result ? 'NEEDS_REVIEW' : 'FAILED',
    method: result?.method ?? null,
    extractedEncrypted: result ? usePiiCipher().encrypt(JSON.stringify(result.fields), extractedContext(scan.id)) : null,
    confidence: result ? result.confidence as Record<string, number> : null,
    failureReason,
    bookingGuestId: guestId,
  }, new Date())
}

/**
 * The job `booking.passport-read` (v7 §13): claims a QUEUED scan (idempotent: anything else is left alone, except a
 * reading that crashed long ago), reads it and stores the encrypted reading for review — NEEDS_REVIEW, or FAILED
 * when nothing could be read. A reading that throws ends FAILED (`READ_ERROR`, typed in by hand), never stuck.
 */
export async function readPassportScan(db: Db, organizationId: string, scanId: string, now: Date): Promise<void> {
  const scope = await organizationScopeById(db, organizationId)
  if (!scope) return
  const repos = bookingOrgRepos(db, scope)
  const scan = await repos.passportScans.startReading(scanId, now)
  if (!scan) return
  try {
    await readAndPlace(db, scope, scan, now)
  }
  catch (error) {
    console.error(`[passport] reading scan ${scanId} failed:`, error instanceof Error ? error.message : error)
    await repos.passportScans.recordReading(scanId, { status: 'FAILED', method: null, extractedEncrypted: null, confidence: null, failureReason: 'READ_ERROR', bookingGuestId: null }, new Date())
  }
}
