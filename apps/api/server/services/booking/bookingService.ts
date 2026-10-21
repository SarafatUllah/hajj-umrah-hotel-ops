import { randomBytes } from 'node:crypto'
import { type BookingStatus, CONFIRMED_BOOKING_STATUSES, PENDING_BOOKING_STATUSES } from '@hajj/contracts/constants/booking'
import type { PriceLineKind, PriceSource } from '@hajj/contracts/constants/pricing'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { HoldRequestInput, ListBookingsQuery, StaffHoldRequestInput, StaffStaySearchInput, StaySearchInput } from '@hajj/contracts/schemas/booking'
import { toEpochDay } from '@hajj/contracts/utils/dates'
import { effectiveBookingStatus, type ReceiptLine, receiptLines } from '../../domain/booking/bookingView'
import { ConflictError, NotFoundError } from '../../errors/domainError'
import { bookingOrgRepos, tenantRepos } from '../../repositories'
import type { BookingListRow, BookingRoomLine, BookingRow } from '../../repositories/booking'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import { authorizeHotel, requireOrgPermission } from '../../security/authorize'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import type { OrganizationScope } from '../../security/scope'
import { findAgencyBrief } from '../accounts'
import { type HeldBooking, placeHold, searchStay, type StaySearchResult } from './holdService'
import type { Booker } from './stayFacts'

type Db = Parameters<typeof bookingOrgRepos>[0]

export interface BookingDto {
  id: string
  bookingNo: string
  hotelId: string
  bookerType: string
  agencyId: string | null
  customerId: string | null
  bookingType: string
  checkIn: string
  checkOut: string
  maleCount: number
  femaleCount: number
  childCount: number
  infantCount: number
  totalCount: number
  childSide: string | null
  /** Effective: a pending booking past its hold expiry reads EXPIRED. */
  status: BookingStatus
  holdExpiresAt: string | null
  confirmedAt: string | null
  priceSource: PriceSource
  quoteId: string | null
  totalHalalas: number
  createdAt: string
}

export interface BookingPage { items: BookingDto[], total: number, page: number, pageSize: number }

export interface BookingDetailDto extends BookingDto {
  rooms: BookingRoomLine[]
  /** v7 §7 "pilgrim details 12/30": slots with full details (READY or further) out of all slots. */
  guests: { total: number, withDetails: number, checkedIn: number }
  priceLines: Array<{ night: string, kind: PriceLineKind, roomTypeId: string | null, quantity: number, unitAmountHalalas: number, amountHalalas: number, vatIncluded: boolean }>
  /** The random token the receipt's QR carries (v7 §21); only once confirmed. */
  receiptToken: string | null
  notes: string | null
}

/** The receipt (v7 §7): booking number, hotel, stay, rooms, the price with extra beds on their own lines, and the QR token. */
export interface ReceiptDto {
  bookingNo: string
  status: BookingStatus
  hotel: { name: string, code: string, city: string, address: string | null }
  agencyName: string | null
  bookingType: string
  checkIn: string
  checkOut: string
  nights: number
  counts: { men: number, women: number, children: number, infants: number, total: number }
  rooms: Array<{ roomNumber: string, floorLevel: number, occupancy: string, extraBeds: number }>
  lines: Array<ReceiptLine & { roomTypeName: string | null }>
  totalHalalas: number
  confirmedAt: string
  qrToken: string
}

const PENDING: readonly string[] = PENDING_BOOKING_STATUSES
const CONFIRMED: readonly string[] = CONFIRMED_BOOKING_STATUSES
const WITH_DETAILS = ['READY', 'CHECKED_IN', 'CHECKED_OUT']

/** 24 random bytes: the receipt's QR content, never the booking id or personal data (v7 §21). */
const newReceiptToken = () => randomBytes(24).toString('base64url')

function toBookingDto(row: BookingRow, totalHalalas: number, now: Date): BookingDto {
  return {
    id: row.id,
    bookingNo: row.bookingNo,
    hotelId: row.hotelId,
    bookerType: row.bookerType,
    agencyId: row.agencyId,
    customerId: row.customerId,
    bookingType: row.bookingType,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    maleCount: row.maleCount,
    femaleCount: row.femaleCount,
    childCount: row.childCount,
    infantCount: row.infantCount,
    totalCount: row.totalCount,
    childSide: row.childSide,
    status: effectiveBookingStatus({ status: row.status as BookingStatus, holdExpiresAt: row.holdExpiresAt }, now),
    holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    priceSource: row.priceSource as PriceSource,
    quoteId: row.quoteId,
    totalHalalas,
    createdAt: row.createdAt.toISOString(),
  }
}

const toPage = (result: { rows: BookingListRow[], total: number }, query: Pick<ListBookingsQuery, 'page' | 'pageSize'>, now: Date): BookingPage =>
  ({ items: result.rows.map(r => toBookingDto(r, r.totalHalalas, now)), total: result.total, page: query.page, pageSize: query.pageSize })

async function detailOf(db: Db, scope: OrganizationScope, row: BookingRow, now: Date): Promise<BookingDetailDto> {
  const details = await bookingOrgRepos(db, scope).records.details(row.id)
  const count = (statuses: readonly string[]) => statuses.reduce((sum, s) => sum + (details.guestStatuses[s] ?? 0), 0)
  const total = Object.entries(details.guestStatuses).reduce((sum, [status, n]) => sum + (status === 'REMOVED' ? 0 : n), 0)
  return {
    ...toBookingDto(row, details.priceLines.reduce((sum, l) => sum + l.amountHalalas, 0), now),
    rooms: details.rooms,
    guests: { total, withDetails: count(WITH_DETAILS), checkedIn: count(['CHECKED_IN']) },
    priceLines: details.priceLines.map(l => ({ night: l.night, kind: l.kind as PriceLineKind, roomTypeId: l.roomTypeId, quantity: l.quantity, unitAmountHalalas: l.unitAmountHalalas, amountHalalas: l.amountHalalas, vatIncluded: l.vatIncluded })),
    receiptToken: CONFIRMED.includes(row.status) ? row.receiptToken : null,
    notes: row.notes,
  }
}

/**
 * v7 §10: confirms a HELD (agency) or REQUESTED (individual) booking whose hold has not lapsed. Only the booking row
 * is locked — never rooms: the seats were checked and claimed when the hold was made. Stamps the receipt token,
 * marks a quote it used ACCEPTED, logs the change. Idempotent: an already confirmed booking comes back as it is
 * (a retry after a lost answer). A lapsed or expired hold is 409 `HOLD_EXPIRED` (search again); a cancelled booking
 * 409 `BOOKING_NOT_PENDING`. The hotel must be active (409 `HOTEL_INACTIVE`).
 */
async function confirm(db: Db, scope: OrganizationScope, row: BookingRow, actor: { kind: ActorKind, id: string | null }, confirmedBy: string | null, now: Date): Promise<BookingDetailDto> {
  const hotel = await tenantRepos(db, scope).hotels.findById(row.hotelId)
  if (hotel?.status !== 'ACTIVE') throw new ConflictError('HOTEL_INACTIVE')
  const confirmed = await db.transaction(async (tx) => {
    const repos = bookingOrgRepos(tx, scope)
    const updated = await repos.records.confirm(row.id, { now, confirmedBy, receiptToken: newReceiptToken() })
    if (!updated) {
      const current = await repos.records.findById(row.id)
      if (current && CONFIRMED.includes(current.status)) return current
      throw current && (PENDING.includes(current.status) || current.status === 'EXPIRED')
        ? new ConflictError('HOLD_EXPIRED', 'The hold has expired; search again')
        : new ConflictError('BOOKING_NOT_PENDING', `A booking that is ${current?.status ?? 'gone'} cannot be confirmed`)
    }
    if (updated.quoteId) await repos.quotes.markAccepted(updated.quoteId, now)
    await repos.records.recordChange({ bookingId: updated.id, kind: 'CONFIRMED', before: { status: row.status }, after: { status: updated.status }, actor })
    return updated
  })
  return detailOf(db, scope, confirmed, now)
}

/** The receipt of a confirmed booking (a pending one has none yet: 409 `NOT_CONFIRMED`). */
async function receiptOf(db: Db, scope: OrganizationScope, row: BookingRow): Promise<ReceiptDto> {
  if (!CONFIRMED.includes(row.status) || !row.receiptToken || !row.confirmedAt) throw new ConflictError('NOT_CONFIRMED', 'A receipt exists once the booking is confirmed')
  const tenant = tenantRepos(db, scope)
  const [hotel, agency, details] = await Promise.all([
    tenant.hotels.findById(row.hotelId),
    row.agencyId ? findAgencyBrief(db, scope, row.agencyId) : Promise.resolve(null),
    bookingOrgRepos(db, scope).records.details(row.id),
  ])
  const lines = receiptLines(details.priceLines.map(l => ({ ...l, kind: l.kind as PriceLineKind })))
  const types = new Map((await tenant.roomTypes.findByIds([...new Set(lines.flatMap(l => (l.roomTypeId ? [l.roomTypeId] : [])))])).map(t => [t.id, t.name]))
  return {
    bookingNo: row.bookingNo,
    status: row.status as BookingStatus,
    hotel: { name: hotel!.name, code: hotel!.code, city: hotel!.city, address: hotel!.address },
    agencyName: agency?.name ?? null,
    bookingType: row.bookingType,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    nights: toEpochDay(row.checkOut) - toEpochDay(row.checkIn),
    counts: { men: row.maleCount, women: row.femaleCount, children: row.childCount, infants: row.infantCount, total: row.totalCount },
    rooms: details.rooms.map(r => ({ roomNumber: r.roomNumber, floorLevel: r.floorLevel, occupancy: r.occupancy, extraBeds: r.extraBeds })),
    lines: lines.map(l => ({ ...l, roomTypeName: l.roomTypeId ? types.get(l.roomTypeId) ?? null : null })),
    totalHalalas: lines.reduce((sum, l) => sum + l.amountHalalas, 0),
    confirmedAt: row.confirmedAt.toISOString(),
    qrToken: row.receiptToken,
  }
}

// ---- Agency portal (the routes require an approved agency) ----

const agencyBooker = (ctx: AgencyContext): Booker => ({ kind: 'AGENCY', agencyId: ctx.scope.agencyId, agencyUserId: ctx.identity.agencyUserId, staffUserId: null })

/** An agency sees only its own bookings; another agency's booking is "not found". */
async function loadForAgency(ctx: AgencyContext, bookingId: string): Promise<BookingRow> {
  const row = await bookingOrgRepos(ctx.db, ctx.scope).records.findById(bookingId)
  if (!row || row.agencyId !== ctx.scope.agencyId) throw new NotFoundError('BOOKING_NOT_FOUND')
  return row
}

/** v7 §9: the agency's room options for a stay (rate limited per agency: each search runs the allocator). */
export async function searchAgencyStay(ctx: AgencyContext, input: StaySearchInput): Promise<StaySearchResult> {
  await consumeRateLimit(ctx.db, RATE_LIMITS.staySearchPerAgency, ctx.scope.agencyId, ctx.now())
  return searchStay(ctx.db, ctx.scope, agencyBooker(ctx), input, ctx.now())
}

/** v7 §10: the agency holds the option it chose (HELD for the hold minutes). */
export async function holdAgencyStay(ctx: AgencyContext, input: HoldRequestInput): Promise<HeldBooking> {
  await consumeRateLimit(ctx.db, RATE_LIMITS.holdPerAgency, ctx.scope.agencyId, ctx.now())
  return placeHold(ctx.db, ctx.scope, agencyBooker(ctx), input, ctx.now())
}

export async function listAgencyBookings(ctx: AgencyContext, query: ListBookingsQuery): Promise<BookingPage> {
  return toPage(await bookingOrgRepos(ctx.db, ctx.scope).records.list({ ...query, agencyId: ctx.scope.agencyId, now: ctx.now() }), query, ctx.now())
}

export async function getAgencyBooking(ctx: AgencyContext, bookingId: string): Promise<BookingDetailDto> {
  return detailOf(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId), ctx.now())
}

export async function confirmAgencyBooking(ctx: AgencyContext, bookingId: string): Promise<BookingDetailDto> {
  const row = await loadForAgency(ctx, bookingId)
  return confirm(ctx.db, ctx.scope, row, { kind: 'agency', id: ctx.identity.agencyUserId }, null, ctx.now())
}

export async function agencyBookingReceipt(ctx: AgencyContext, bookingId: string): Promise<ReceiptDto> {
  return receiptOf(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId))
}

// ---- Staff (ops console) ----

const onBehalfOf = (ctx: AuthContext, agencyId: string): Booker => ({ kind: 'AGENCY', agencyId, agencyUserId: null, staffUserId: ctx.identity.userId })

/**
 * A booking of a hotel the caller cannot access is "not found" (the hotel's 404 rule). Reading works for an inactive
 * hotel; confirming does not (409 `HOTEL_INACTIVE`).
 */
async function loadForStaff(ctx: AuthContext, bookingId: string, permission: 'booking.view' | 'booking.create'): Promise<BookingRow> {
  const row = await bookingOrgRepos(ctx.db, ctx.scope).records.findById(bookingId)
  if (!row) throw new NotFoundError('BOOKING_NOT_FOUND')
  await authorizeHotel(ctx, permission, row.hotelId, { allowInactive: permission === 'booking.view' }).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new NotFoundError('BOOKING_NOT_FOUND')
    throw error
  })
  return row
}

/** v7 §6: a seller or manager searches on an agency's behalf (`booking.create` on the hotel). */
export async function searchStayForAgency(ctx: AuthContext, input: StaffStaySearchInput): Promise<StaySearchResult> {
  await authorizeHotel(ctx, 'booking.create', input.hotelId)
  return searchStay(ctx.db, ctx.scope, onBehalfOf(ctx, input.agencyId), input, ctx.now())
}

/** v7 §6: a seller or manager holds an option on an agency's behalf; the booking is the agency's. */
export async function holdStayForAgency(ctx: AuthContext, input: StaffHoldRequestInput): Promise<HeldBooking> {
  await authorizeHotel(ctx, 'booking.create', input.hotelId)
  return placeHold(ctx.db, ctx.scope, onBehalfOf(ctx, input.agencyId), input, ctx.now())
}

/** Staff list (`booking.view`): only bookings of hotels the caller can access. */
export async function listBookings(ctx: AuthContext, query: ListBookingsQuery): Promise<BookingPage> {
  requireOrgPermission(ctx, 'booking.view')
  const hotelIds = ctx.authz.allHotels ? undefined : [...ctx.authz.hotelIds]
  return toPage(await bookingOrgRepos(ctx.db, ctx.scope).records.list({ ...query, hotelIds, now: ctx.now() }), query, ctx.now())
}

export async function getBooking(ctx: AuthContext, bookingId: string): Promise<BookingDetailDto> {
  return detailOf(ctx.db, ctx.scope, await loadForStaff(ctx, bookingId, 'booking.view'), ctx.now())
}

/** Staff with `booking.create` on the hotel (sellers and managers) confirm an agency's hold or an individual's request (v7 §7). */
export async function confirmBooking(ctx: AuthContext, bookingId: string): Promise<BookingDetailDto> {
  const row = await loadForStaff(ctx, bookingId, 'booking.create')
  return confirm(ctx.db, ctx.scope, row, { kind: 'staff', id: ctx.identity.userId }, ctx.identity.userId, ctx.now())
}

export async function bookingReceipt(ctx: AuthContext, bookingId: string): Promise<ReceiptDto> {
  return receiptOf(ctx.db, ctx.scope, await loadForStaff(ctx, bookingId, 'booking.view'))
}
