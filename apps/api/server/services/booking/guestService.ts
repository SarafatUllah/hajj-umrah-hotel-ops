import { type AgeGroup, type BookingType, type Gender, type Occupancy, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { GuestDetailsInput, ListGuestsQuery } from '@hajj/contracts/schemas/guest'
import { checkGuest, isComplete, maskPassport, PASSPORT_LOOKUP_CONTEXT, passportLookupInput } from '../../domain/booking/guestRules'
import { orgCan } from '../../domain/rbac/authorize'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos } from '../../repositories'
import type { BookingRow, GuestSlotRow, PassportOverlap } from '../../repositories/booking'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import { requireOrgPermission } from '../../security/authorize'
import { type PiiCipher, PiiDecryptionError } from '../../security/piiCrypto'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import type { OrganizationScope } from '../../security/scope'
import { usePiiCipher } from '../../utils/pii'
import { loadForAgency, loadForStaff } from './bookingAccess'
import { loadBookingSettings } from './bookingSettingsService'

type Db = Parameters<typeof bookingOrgRepos>[0]
type Repos = ReturnType<typeof bookingOrgRepos>
type Settings = Awaited<ReturnType<typeof loadBookingSettings>>

export interface GuestDetailsDto {
  fullName: string
  gender: Gender | null
  nationality: string | null
  dateOfBirth: string | null
  /** Masked (`•••789`) unless the caller may see the full number — and then the read is logged. */
  passportNo: string | null
  passportExpiry: string | null
  /** The printed-page extras (address, place of birth …): only with the full view. */
  extras: Record<string, string> | null
  /** Everything check-in needs is there (v7 §7 READY). */
  complete: boolean
}

export type GuestWarning =
  | { code: 'PASSPORT_EXPIRES_SOON' }
  /** Staff only: the same passport in another live booking on overlapping nights (in a hotel the viewer can see). */
  | { code: 'DUPLICATE_PASSPORT', bookingNo: string }
  /** Staff only, on save: the staff master of this passport says something else (it is not overwritten). */
  | { code: 'MASTER_DIFFERS' }
  /** The stored details could not be decrypted (wrong key ring): shown empty, logged for the operators. */
  | { code: 'DETAILS_UNREADABLE' }

export interface GuestSlotDto {
  id: string
  slotNo: number
  gender: Gender | null
  ageGroup: AgeGroup
  isExtraBed: boolean
  status: string
  roomNumber: string | null
  details: GuestDetailsDto | null
  warnings: GuestWarning[]
}

type Actor = { kind: ActorKind, id: string | null }

/**
 * Who reads: the full view (passport numbers and extras, logged) and the staff-only duplicate-passport warnings —
 * `warnHotelIds`: the hotels the viewer can see (null = all, undefined = no such warnings).
 */
interface Viewer { actor: Actor, full: boolean, warnHotelIds?: readonly string[] | null }

/**
 * Who writes: agencies never touch the staff master and cannot change a slot once it has checked in. Staff create
 * a master on first sight; only staff who may see passports (`mergesMaster`) link to an existing one and learn
 * whether it differs — for anyone else the answer must not tell whether a master exists (no oracle).
 */
export interface Writer {
  actor: Actor
  writesMaster: boolean
  mergesMaster: boolean
  lockedStatuses: readonly string[]
  warnHotelIds?: readonly string[] | null
  /** Runs in the save's transaction once the booker's copy is written (e.g. a passport scan's review marks the scan). */
  afterSave?: (tx: Db, saved: { detailId: string, guestId: string }) => Promise<void>
}

// Ciphertexts are bound to the row they belong to: a booker's copy is one per slot, a master one per passport.
const passportContext = (guestId: string) => `booking_guest_detail.passport_no:${guestId}`
const extrasContext = (guestId: string) => `booking_guest_detail.details:${guestId}`
const masterPassportContext = (lookup: string) => `pilgrim.passport_no:${lookup}`

const LIVE: readonly string[] = SEAT_HOLDING_STATUSES
const DETAILS_STAGES = ['PENDING_DETAILS', 'READY']

function toSlotDto(row: GuestSlotRow, booking: BookingRow, settings: Settings, viewer: Viewer, overlaps: readonly PassportOverlap[], cipher: PiiCipher): GuestSlotDto {
  const { guest, detail } = row
  const base = { id: guest.id, slotNo: guest.slotNo, gender: guest.gender as Gender | null, ageGroup: guest.ageGroup as AgeGroup, isExtraBed: guest.isExtraBed, status: guest.status, roomNumber: row.roomNumber }
  if (!detail) return { ...base, details: null, warnings: [] }
  try {
    return { ...base, ...readDetails(row, booking, settings, viewer, overlaps, cipher) }
  }
  catch (error) {
    if (!(error instanceof PiiDecryptionError)) throw error
    // One unreadable row (a key missing from the ring) must not hide the whole booking's list.
    console.error(`[guests] details of slot ${guest.id} could not be decrypted:`, error.message)
    return { ...base, details: null, warnings: [{ code: 'DETAILS_UNREADABLE' }] }
  }
}

function readDetails(row: GuestSlotRow, booking: BookingRow, settings: Settings, viewer: Viewer, overlaps: readonly PassportOverlap[], cipher: PiiCipher): Pick<GuestSlotDto, 'details' | 'warnings'> {
  const { guest } = row
  const detail = row.detail!
  const passportNo = detail.passportNoEncrypted ? cipher.decrypt(detail.passportNoEncrypted, passportContext(guest.id)) : null
  const facts = { fullName: detail.fullName, gender: detail.gender as Gender | null, nationality: detail.nationality, dateOfBirth: detail.dateOfBirth, passportNo, passportExpiry: detail.passportExpiry }
  const slot = { bookingType: booking.bookingType as BookingType, ageGroup: guest.ageGroup as AgeGroup, occupancy: row.occupancy as Occupancy | null, checkIn: booking.checkIn }
  const warnings: GuestWarning[] = [
    ...checkGuest(slot, facts, settings).issues.filter(i => !i.blocking).map(i => ({ code: i.code as 'PASSPORT_EXPIRES_SOON' })),
    ...overlaps.filter(o => o.passportLookup === detail.passportLookup).map(o => ({ code: 'DUPLICATE_PASSPORT' as const, bookingNo: o.bookingNo })),
  ]
  return {
    details: {
      ...facts,
      passportNo: passportNo && (viewer.full ? passportNo : maskPassport(passportNo)),
      extras: viewer.full && detail.detailsEncrypted ? JSON.parse(cipher.decrypt(detail.detailsEncrypted, extrasContext(guest.id))) as Record<string, string> : null,
      complete: isComplete(facts),
    },
    warnings,
  }
}

/** The booking's slots as the viewer may see them; a full view of personal data is logged (v7 §13 PDPL). */
async function slotsOf(db: Db, scope: OrganizationScope, booking: BookingRow, viewer: Viewer): Promise<GuestSlotDto[]> {
  const repos = bookingOrgRepos(db, scope)
  const [rows, settings] = await Promise.all([repos.guests.listForBooking(booking.id), loadBookingSettings(db, scope)])
  const lookups = rows.flatMap(r => (r.detail?.passportLookup ? [r.detail.passportLookup] : []))
  const overlaps = viewer.warnHotelIds !== undefined ? await repos.guests.passportOverlaps(lookups, booking, booking.id, viewer.warnHotelIds ?? undefined) : []
  const cipher = usePiiCipher()
  const slots = rows.map(row => toSlotDto(row, booking, settings, viewer, overlaps, cipher))
  if (viewer.full) {
    await repos.piiAccess.record(rows.flatMap(({ detail }) => {
      const fields = [...(detail?.passportNoEncrypted ? ['passport_no'] : []), ...(detail?.detailsEncrypted ? ['details'] : [])]
      return detail && fields.length > 0 ? [{ actorKind: viewer.actor.kind, actorId: viewer.actor.id, subjectType: 'BOOKING_GUEST_DETAIL', subjectId: detail.id, fields, purpose: 'guest list' }] : []
    }))
  }
  return slots
}

/**
 * Staff link a slot to the master of its passport (v7 §16: staff merge, ticket 1). Complete details create the
 * master on first sight; an existing master is never overwritten — a difference comes back as MASTER_DIFFERS.
 */
async function linkMaster(repos: Repos, lookup: string, input: GuestDetailsInput, cipher: PiiCipher, merges: boolean): Promise<{ pilgrimId: string | null, differs: boolean }> {
  if (!isComplete(input)) {
    const existing = merges ? await repos.pilgrims.findByLookup(lookup) : null
    return { pilgrimId: existing?.id ?? null, differs: false }
  }
  const { row, created } = await repos.pilgrims.createIfAbsent({
    fullName: input.fullName,
    gender: input.gender!,
    nationality: input.nationality!,
    dateOfBirth: input.dateOfBirth!,
    passportNoEncrypted: cipher.encrypt(input.passportNo!, masterPassportContext(lookup)),
    passportLookup: lookup,
    passportExpiry: input.passportExpiry!,
  })
  if (!created && !merges) return { pilgrimId: null, differs: false }
  const differs = !created && (row.fullName !== input.fullName || row.gender !== input.gender || row.dateOfBirth !== input.dateOfBirth || row.passportExpiry !== input.passportExpiry)
  return { pilgrimId: row.id, differs }
}

/**
 * Saves one slot's details (v7 §7, §13): the booker's copy (passport number and extras encrypted), the slot's age
 * group from the date of birth on the check-in day, READY once complete. Refused (422 `GUEST_DETAILS_REJECTED`) when
 * the person does not fit the slot — the other gender's side from the child age on, or an infant slot for someone
 * older — and when the same passport is already in another slot of this booking. Logged as DETAILS_UPDATED (no PII).
 */
export async function saveSlot(db: Db, scope: OrganizationScope, booking: BookingRow, guestId: string, input: GuestDetailsInput, writer: Writer): Promise<GuestSlotDto> {
  const settings = await loadBookingSettings(db, scope)
  const cipher = usePiiCipher()
  const lookup = input.passportNo && input.nationality ? cipher.blindIndex(passportLookupInput(input.nationality, input.passportNo), PASSPORT_LOOKUP_CONTEXT) : null

  const masterDiffers = await db.transaction(async (tx) => {
    const repos = bookingOrgRepos(tx, scope)
    // The booking row first (then the slot): saves of one booking's slots serialize, so the duplicate-passport
    // check cannot race, and the status read here is the current one.
    const current = await repos.records.findById(booking.id, { forUpdate: true })
    if (!current || !LIVE.includes(current.status)) throw new ConflictError('BOOKING_CLOSED', `Details cannot change on a booking that is ${current?.status ?? 'gone'}`)
    const slot = await repos.guests.findSlot(booking.id, guestId, { forUpdate: true })
    if (!slot) throw new NotFoundError('GUEST_NOT_FOUND')
    if (writer.lockedStatuses.includes(slot.guest.status)) throw new ConflictError('GUEST_LOCKED', `A pilgrim who is ${slot.guest.status} can only be changed by the hotel`)
    const checked = checkGuest({ bookingType: booking.bookingType as BookingType, ageGroup: slot.guest.ageGroup as AgeGroup, occupancy: slot.occupancy as Occupancy | null, checkIn: booking.checkIn }, input, settings)
    const blocking = checked.issues.filter(i => i.blocking).map(i => i.code)
    if (blocking.length > 0) throw new ValidationError('GUEST_DETAILS_REJECTED', 'These details do not fit this slot; use another slot', { issues: blocking })
    if (lookup && (await repos.guests.listForBooking(booking.id)).some(r => r.guest.id !== guestId && r.guest.status !== 'REMOVED' && r.detail?.passportLookup === lookup)) {
      throw new ValidationError('DUPLICATE_PASSPORT_IN_BOOKING', 'This passport is already in another slot of this booking')
    }

    const detail = await repos.guests.saveDetail({
      bookingId: booking.id,
      bookingGuestId: guestId,
      fullName: input.fullName,
      gender: input.gender ?? null,
      nationality: input.nationality ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      passportNoEncrypted: input.passportNo ? cipher.encrypt(input.passportNo, passportContext(guestId)) : null,
      passportLookup: lookup,
      passportExpiry: input.passportExpiry ?? null,
      detailsEncrypted: input.extras && Object.keys(input.extras).length > 0 ? cipher.encrypt(JSON.stringify(input.extras), extrasContext(guestId)) : null,
      enteredByKind: writer.actor.kind,
      enteredById: writer.actor.id,
    })
    const complete = isComplete(input)
    // Agencies never link (a typed passport must not attach a slot to someone's master); their change of passport unlinks.
    const link = !lookup ? { pilgrimId: null, differs: false }
      : writer.writesMaster ? await linkMaster(repos, lookup, input, cipher, writer.mergesMaster)
        : { pilgrimId: slot.detail?.passportLookup === lookup ? slot.guest.pilgrimId : null, differs: false }
    const status = DETAILS_STAGES.includes(slot.guest.status) ? (complete ? 'READY' : 'PENDING_DETAILS') : slot.guest.status
    await repos.guests.updateSlot(booking.id, guestId, { gender: input.gender ?? slot.guest.gender, ageGroup: checked.ageGroup, status, pilgrimId: link.pilgrimId })
    await repos.records.recordChange({ bookingId: booking.id, kind: 'DETAILS_UPDATED', before: { slotNo: slot.guest.slotNo, status: slot.guest.status }, after: { slotNo: slot.guest.slotNo, status, complete }, actor: writer.actor })
    if (writer.afterSave) await writer.afterSave(tx, { detailId: detail.id, guestId })
    return link.differs
  }).catch(rethrowDbError)

  // The answer shows the slot masked: the writer just typed the number, and an echo would only add PII to logs.
  const slots = await slotsOf(db, scope, booking, { actor: writer.actor, full: false, warnHotelIds: writer.warnHotelIds })
  const saved = slots.find(s => s.id === guestId)!
  return masterDiffers ? { ...saved, warnings: [...saved.warnings, { code: 'MASTER_DIFFERS' }] } : saved
}

/** Slot statuses an agency can no longer change (the hotel can, except a removed slot). */
export const AGENCY_LOCKED = ['CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'REMOVED']

/** The writer of a staff save: complete details create the master; only staff who may see passports merge into one. */
export const staffWriter = (ctx: AuthContext): Writer => ({ actor: { kind: 'staff', id: ctx.identity.userId }, writesMaster: true, mergesMaster: orgCan(ctx.authz, 'pilgrim.viewSensitive'), lockedStatuses: ['REMOVED'], warnHotelIds: visibleHotels(ctx) })

/** The writer of an agency save. */
export const agencyWriter = (ctx: AgencyContext): Writer => ({ actor: { kind: 'agency', id: ctx.identity.agencyUserId }, writesMaster: false, mergesMaster: false, lockedStatuses: AGENCY_LOCKED })

/** Agency portal: its booking's slots with its own copies in full (the read is logged; rate limited per agency user). */
export async function listAgencyGuests(ctx: AgencyContext, bookingId: string): Promise<GuestSlotDto[]> {
  const booking = await loadForAgency(ctx, bookingId)
  await consumeRateLimit(ctx.db, RATE_LIMITS.guestListPerAgencyUser, ctx.identity.agencyUserId, ctx.now())
  return slotsOf(ctx.db, ctx.scope, booking, { actor: { kind: 'agency', id: ctx.identity.agencyUserId }, full: true })
}

/** Agency portal: enter or correct a pilgrim's details (v7 §5 rule 16: never another agency's). */
export async function saveAgencyGuest(ctx: AgencyContext, bookingId: string, guestId: string, input: GuestDetailsInput): Promise<GuestSlotDto> {
  const booking = await loadForAgency(ctx, bookingId)
  return saveSlot(ctx.db, ctx.scope, booking, guestId, input, agencyWriter(ctx))
}

/**
 * Staff (`pilgrim.view` on the hotel): names and dates, passport numbers masked, duplicate-passport warnings.
 * `reveal=passport` (`pilgrim.viewSensitive`) shows full numbers and extras, and logs the read.
 */
export async function listGuests(ctx: AuthContext, bookingId: string, query: ListGuestsQuery): Promise<GuestSlotDto[]> {
  const booking = await loadForStaff(ctx, bookingId, 'pilgrim.view', { allowInactive: true })
  if (query.reveal) {
    requireOrgPermission(ctx, 'pilgrim.viewSensitive')
    await consumeRateLimit(ctx.db, RATE_LIMITS.piiRevealPerStaff, ctx.identity.userId, ctx.now())
  }
  return slotsOf(ctx.db, ctx.scope, booking, { actor: { kind: 'staff', id: ctx.identity.userId }, full: query.reveal === 'passport', warnHotelIds: visibleHotels(ctx) })
}

/** The hotels a staff member's duplicate-passport warnings may name (null = every hotel). */
const visibleHotels = (ctx: AuthContext): readonly string[] | null => (ctx.authz.allHotels ? null : [...ctx.authz.hotelIds])

/** Staff (`booking.edit`: managers, reception at arrival): enter or correct details; complete details refresh the staff master. */
export async function saveGuest(ctx: AuthContext, bookingId: string, guestId: string, input: GuestDetailsInput): Promise<GuestSlotDto> {
  const booking = await loadForStaff(ctx, bookingId, 'booking.edit')
  return saveSlot(ctx.db, ctx.scope, booking, guestId, input, staffWriter(ctx))
}
