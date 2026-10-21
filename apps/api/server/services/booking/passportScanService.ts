import { createHash } from 'node:crypto'
import { SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import { PASSPORT_IMAGE_TYPES, type PassportImageType, type PassportScanMethod, type PassportScanStatus } from '@hajj/contracts/constants/pilgrimData'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import type { PassportScanDto } from '@hajj/contracts/types/booking'
import { todayInTimezone } from '@hajj/contracts/utils/dates'
import { addMonths } from '../../domain/booking/guestRules'
import { REVIEW_THRESHOLD, type ScanConfidence, type ScanFields } from '../../domain/booking/passportScan'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, tenantRepos } from '../../repositories'
import type { BookingRow, PassportScanRow } from '../../repositories/booking'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import { requireOrgPermission } from '../../security/authorize'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import type { OrganizationScope } from '../../security/scope'
import { generateStorageKey, getStorageDriver, imageSize, UploadRejectedError, type ValidatedUpload, validateUpload } from '../../storage'
import { usePiiCipher } from '../../utils/pii'
import { loadForAgency, loadForStaff } from './bookingAccess'
import { loadBookingSettings } from './bookingSettingsService'
import { agencyWriter, type GuestSlotDto, saveSlot, staffWriter, type Writer } from './guestService'
import { extractedContext, imageContext, purgeImage, readStoredImage } from './passportImages'

type Db = Parameters<typeof bookingOrgRepos>[0]
type Actor = { kind: ActorKind, id: string | null }

export interface ScanUpload { bytes: Uint8Array, mimeType: string, filename: string }

export type { PassportScanDto }

/** The job that reads one scan (heavy tier: worker process only). Set by `server/jobs/passportJobs.ts`. */
type QueueRead = (tx: Db, data: { organizationId: string, scanId: string }) => Promise<unknown>
let queueRead: QueueRead | null = null

/** Wired once at startup by the jobs module (and replaced in tests): uploads enqueue a reading in their transaction. */
export function setPassportReadQueue(queue: QueueRead | null): void {
  queueRead = queue
}

const IMAGE_TYPES: readonly string[] = PASSPORT_IMAGE_TYPES
/** A phone photo is 12–50 MP; anything larger is refused before OCR ever decodes it (a decompression bomb). */
const MAX_IMAGE_PIXELS = 60_000_000
/** Unresolved scans a booking may hold beyond one per pilgrim (re-takes of a blurred photo). */
const SPARE_SCANS = 5
const IMAGE_DIGEST_CONTEXT = 'passport_scan.image_digest'
const REVIEW_FIELDS: Array<keyof ScanFields> = ['fullName', 'gender', 'nationality', 'dateOfBirth', 'passportNo', 'passportExpiry']
const LIVE: readonly string[] = SEAT_HOLDING_STATUSES

/** A discarded scan shows no data even before its image and reading are deleted. */
const hasReading = (row: PassportScanRow) => row.extractedEncrypted !== null && row.status !== 'DISCARDED'
const actorKey = (actor: Actor) => `${actor.kind}:${actor.id ?? ''}`

/** The stored reading; null (logged without content) when it cannot be decrypted, so one bad row never hides the rest. */
function readingOf(row: PassportScanRow): ScanFields | null {
  if (!hasReading(row)) return null
  try {
    return JSON.parse(usePiiCipher().decrypt(row.extractedEncrypted!, extractedContext(row.id))) as ScanFields
  }
  catch (error) {
    console.error(`[passport] the reading of scan ${row.id} cannot be decrypted:`, error instanceof Error ? error.name : error)
    return null
  }
}

function toScanDto(row: PassportScanRow): PassportScanDto {
  const fields = readingOf(row)
  const confidence = (row.confidence ?? null) as ScanConfidence | null
  return {
    id: row.id,
    status: row.status as PassportScanStatus,
    method: row.method as PassportScanMethod | null,
    guestId: row.bookingGuestId,
    fields,
    confidence,
    needsAttention: fields ? REVIEW_FIELDS.filter(f => fields[f] === undefined || (confidence?.[f] ?? 0) < REVIEW_THRESHOLD) : [],
    failureReason: hasReading(row) && !fields ? 'UNREADABLE_RECORD' : row.failureReason,
    createdAt: row.createdAt.toISOString(),
  }
}

/** A passport photo: PNG or JPEG (the bytes' own signature), up to 10 MB, with a readable header within the pixel limit. */
function validateScanImage(file: ScanUpload): ValidatedUpload {
  let validated: ValidatedUpload
  try {
    validated = validateUpload(file.bytes, file.mimeType, file.filename)
  }
  catch (error) {
    if (error instanceof UploadRejectedError) throw new ValidationError(error.code, error.message)
    throw error
  }
  if (!IMAGE_TYPES.includes(validated.mimeType)) throw new ValidationError('TYPE_NOT_ALLOWED', 'Upload a photo of the passport page (PNG or JPEG)')
  const size = imageSize(file.bytes, validated.mimeType as PassportImageType)
  if (!size) throw new ValidationError('CONTENT_MISMATCH', 'The file is not a readable PNG or JPEG image')
  if (size.width * size.height > MAX_IMAGE_PIXELS) throw new ValidationError('IMAGE_TOO_LARGE', `Photos are limited to ${MAX_IMAGE_PIXELS / 1_000_000} megapixels`)
  return validated
}

/**
 * v7 §13 upload: a passport photo is encrypted before it is stored, then the scan is recorded QUEUED and its
 * reading enqueued in the same transaction (the worker reads it). Uploads are rate limited per user, and a booking
 * holds at most one unresolved scan per pilgrim plus a few re-takes (checked under the booking's row lock). The
 * image is kept until `passportImageRetentionMonths` after check-out (`delete_after`, the retention sweep). Stored
 * objects of a failed transaction are removed again.
 */
async function upload(db: Db, scope: OrganizationScope, booking: BookingRow, file: ScanUpload, uploader: Actor, now: Date): Promise<PassportScanDto> {
  if (!LIVE.includes(booking.status)) throw new ConflictError('BOOKING_CLOSED', `Passports cannot be added to a booking that is ${booking.status}`)
  if (!queueRead) throw new ConflictError('PASSPORT_READING_UNAVAILABLE', 'Passport reading is not running')
  await consumeRateLimit(db, RATE_LIMITS.passportUploadPerUser, actorKey(uploader), now)
  const validated = validateScanImage(file)

  const settings = await loadBookingSettings(db, scope)
  const storage = getStorageDriver()
  const storageKey = generateStorageKey(scope.organizationId, validated.extension)
  await storage.put(storageKey, usePiiCipher().encryptBytes(file.bytes, imageContext(storageKey)))
  let scan: PassportScanRow
  try {
    scan = await db.transaction(async (tx) => {
      const repos = bookingOrgRepos(tx, scope)
      const locked = await repos.records.findById(booking.id, { forUpdate: true })
      if (!locked || !LIVE.includes(locked.status)) throw new ConflictError('BOOKING_CLOSED', 'The booking was closed meanwhile')
      if (await repos.passportScans.countUnresolved(booking.id) >= locked.totalCount + locked.infantCount + SPARE_SCANS) {
        throw new ConflictError('TOO_MANY_SCANS', 'This booking already has a passport photo waiting for every pilgrim: review or discard them first')
      }
      const asset = await tenantRepos(tx, scope).documentAssets.insert({
        storageKey,
        // Never the name people gave the file: it may name the pilgrim, and it would outlive the image.
        originalFilename: `passport${validated.extension}`,
        mimeType: validated.mimeType,
        sizeBytes: file.bytes.length,
        // Keyed (not a bare SHA-256): whoever reads the database cannot test whether a known passport photo is stored.
        sha256: usePiiCipher().blindIndex(createHash('sha256').update(file.bytes).digest('hex'), IMAGE_DIGEST_CONTEXT),
        uploadedBy: uploader.kind === 'staff' ? uploader.id : null,
      })
      const created = await repos.passportScans.insert({
        bookingId: booking.id,
        documentId: asset.id,
        status: 'QUEUED',
        uploadedByKind: uploader.kind,
        uploadedById: uploader.id,
        deleteAfter: addMonths(locked.checkOut, settings.passportImageRetentionMonths),
      })
      await queueRead!(tx, { organizationId: scope.organizationId, scanId: created.id })
      return created
    })
  }
  catch (error) {
    await storage.delete(storageKey).catch((cleanupError: unknown) => console.error('[passport] could not remove an image after a failed upload', { storageKey, cleanupError }))
    throw error
  }
  return toScanDto(scan)
}

/** The scan of this booking, or 404 (a scan id of another booking is "not found"). */
async function scanOf(db: Db, scope: OrganizationScope, booking: BookingRow, scanId: string): Promise<PassportScanRow> {
  const scan = await bookingOrgRepos(db, scope).passportScans.findById(scanId)
  if (!scan || scan.bookingId !== booking.id) throw new NotFoundError('SCAN_NOT_FOUND')
  return scan
}

/** The review cards of a booking; reading them shows personal data, so it is logged (v7 §13 PDPL). */
async function listFor(db: Db, scope: OrganizationScope, booking: BookingRow, viewer: Actor): Promise<PassportScanDto[]> {
  const repos = bookingOrgRepos(db, scope)
  const rows = await repos.passportScans.listForBooking(booking.id)
  await repos.piiAccess.record(rows.filter(hasReading).map(r => ({ actorKind: viewer.kind, actorId: viewer.id, subjectType: 'PASSPORT_SCAN', subjectId: r.id, fields: ['extracted'], purpose: 'passport review' })))
  return rows.map(toScanDto)
}

/** The decrypted image for the review card; logged and rate limited per viewer. A discarded scan's image is gone (404). */
async function imageFor(db: Db, scope: OrganizationScope, booking: BookingRow, scanId: string, viewer: Actor, now: Date): Promise<{ bytes: Buffer, mimeType: string }> {
  await consumeRateLimit(db, RATE_LIMITS.passportImagePerUser, actorKey(viewer), now)
  const scan = await scanOf(db, scope, booking, scanId)
  const asset = await tenantRepos(db, scope).documentAssets.findById(scan.documentId)
  if (!asset || asset.archivedAt || scan.status === 'DISCARDED') throw new NotFoundError('SCAN_NOT_FOUND')
  const bytes = await readStoredImage(asset.storageKey)
  await bookingOrgRepos(db, scope).piiAccess.record([{ actorKind: viewer.kind, actorId: viewer.id, subjectType: 'PASSPORT_SCAN', subjectId: scan.id, fields: ['image'], purpose: 'passport review' }])
  return { bytes, mimeType: asset.mimeType }
}

/**
 * v7 §13 steps 4–5: the reviewer confirms (and corrects) what was read for a slot. Saved through the same rules as a
 * hand entry (gender side, age group, duplicates…); the scan is marked CONFIRMED, pointing at the copy it filled, in
 * the same transaction (ticket 1: the scan targets the booker's copy, never the staff master).
 */
async function confirmFor(db: Db, scope: OrganizationScope, booking: BookingRow, scanId: string, guestId: string, details: unknown, writer: Writer): Promise<GuestSlotDto> {
  const input = guestDetailsSchema.parse(details)
  const scan = await scanOf(db, scope, booking, scanId)
  if (!['NEEDS_REVIEW', 'FAILED'].includes(scan.status)) throw new ConflictError('SCAN_NOT_OPEN', `A scan that is ${scan.status} cannot be confirmed`)
  return saveSlot(db, scope, booking, guestId, input, {
    ...writer,
    afterSave: async (tx, saved) => {
      const confirmed = await bookingOrgRepos(tx, scope).passportScans.confirm(scanId, { bookingGuestId: saved.guestId, bookingGuestDetailId: saved.detailId }, { reviewedByKind: writer.actor.kind, reviewedById: writer.actor.id, reviewedAt: new Date() })
      if (!confirmed) throw new ConflictError('SCAN_NOT_OPEN', 'This scan was confirmed or discarded meanwhile')
    },
  })
}

/**
 * Throws the scan away: the record stays as DISCARDED and its image is due at once — deleted now, or by the
 * retention sweep when the storage cannot be reached.
 */
async function discardFor(db: Db, scope: OrganizationScope, booking: BookingRow, scanId: string, actor: Actor, now: Date): Promise<PassportScanDto> {
  const scan = await scanOf(db, scope, booking, scanId)
  const discarded = await bookingOrgRepos(db, scope).passportScans.discard(scan.id, { reviewedByKind: actor.kind, reviewedById: actor.id, reviewedAt: now }, todayInTimezone('UTC', now))
  if (!discarded) throw new ConflictError('SCAN_NOT_OPEN', `A scan that is ${scan.status} cannot be discarded`)
  const asset = await tenantRepos(db, scope).documentAssets.findById(scan.documentId)
  if (asset && !asset.archivedAt) {
    await purgeImage(db, scope, { scanId: scan.id, documentId: asset.id, storageKey: asset.storageKey }, now)
      .catch((error: unknown) => console.error(`[passport] the image of discarded scan ${scan.id} is left to the retention sweep:`, error instanceof Error ? error.message : error))
  }
  return toScanDto(discarded)
}

// ---- Agency portal (own bookings; the review cards count as a full guest-list view) ----

const agencyActor = (ctx: AgencyContext): Actor => ({ kind: 'agency', id: ctx.identity.agencyUserId })

export async function uploadAgencyScan(ctx: AgencyContext, bookingId: string, file: ScanUpload): Promise<PassportScanDto> {
  return upload(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId), file, agencyActor(ctx), ctx.now())
}
export async function listAgencyScans(ctx: AgencyContext, bookingId: string): Promise<PassportScanDto[]> {
  const booking = await loadForAgency(ctx, bookingId)
  await consumeRateLimit(ctx.db, RATE_LIMITS.guestListPerAgencyUser, ctx.identity.agencyUserId, ctx.now())
  return listFor(ctx.db, ctx.scope, booking, agencyActor(ctx))
}
export async function agencyScanImage(ctx: AgencyContext, bookingId: string, scanId: string): Promise<{ bytes: Buffer, mimeType: string }> {
  return imageFor(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId), scanId, agencyActor(ctx), ctx.now())
}
export async function confirmAgencyScan(ctx: AgencyContext, bookingId: string, scanId: string, body: { guestId: string, details: unknown }): Promise<GuestSlotDto> {
  return confirmFor(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId), scanId, body.guestId, body.details, agencyWriter(ctx))
}
export async function discardAgencyScan(ctx: AgencyContext, bookingId: string, scanId: string): Promise<PassportScanDto> {
  return discardFor(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId), scanId, agencyActor(ctx), ctx.now())
}

// ---- Staff: `booking.edit` on the hotel uploads, confirms and discards (managers, reception); reviewing what was
// read — the cards and the images — shows full passport data, so it also needs `pilgrim.viewSensitive` (as
// `reveal=passport` on the guest list) and is rate limited the same way. ----

const staffActor = (ctx: AuthContext): Actor => ({ kind: 'staff', id: ctx.identity.userId })

export async function uploadScan(ctx: AuthContext, bookingId: string, file: ScanUpload): Promise<PassportScanDto> {
  return upload(ctx.db, ctx.scope, await loadForStaff(ctx, bookingId, 'booking.edit'), file, staffActor(ctx), ctx.now())
}
export async function listScans(ctx: AuthContext, bookingId: string): Promise<PassportScanDto[]> {
  const booking = await loadForStaff(ctx, bookingId, 'booking.edit', { allowInactive: true })
  requireOrgPermission(ctx, 'pilgrim.viewSensitive')
  await consumeRateLimit(ctx.db, RATE_LIMITS.piiRevealPerStaff, ctx.identity.userId, ctx.now())
  return listFor(ctx.db, ctx.scope, booking, staffActor(ctx))
}
export async function scanImage(ctx: AuthContext, bookingId: string, scanId: string): Promise<{ bytes: Buffer, mimeType: string }> {
  const booking = await loadForStaff(ctx, bookingId, 'booking.edit', { allowInactive: true })
  requireOrgPermission(ctx, 'pilgrim.viewSensitive')
  return imageFor(ctx.db, ctx.scope, booking, scanId, staffActor(ctx), ctx.now())
}
export async function confirmScan(ctx: AuthContext, bookingId: string, scanId: string, body: { guestId: string, details: unknown }): Promise<GuestSlotDto> {
  return confirmFor(ctx.db, ctx.scope, await loadForStaff(ctx, bookingId, 'booking.edit'), scanId, body.guestId, body.details, staffWriter(ctx))
}
export async function discardScan(ctx: AuthContext, bookingId: string, scanId: string): Promise<PassportScanDto> {
  return discardFor(ctx.db, ctx.scope, await loadForStaff(ctx, bookingId, 'booking.edit'), scanId, staffActor(ctx), ctx.now())
}
