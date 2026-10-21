import type { BookingStatus, GuestStatus } from '@hajj/contracts/constants/booking'
import type { CheckInLookupInput } from '@hajj/contracts/schemas/booking'
import type { CheckInLookupDto, GuestMoveDto } from '@hajj/contracts/types/frontDesk'
import { addDays, type IsoDate, todayInTimezone } from '@hajj/contracts/utils/dates'
import { bookingStatusAfter, GUEST_MOVES, type GuestMove, type MoveRefusal, refuseMove } from '../../domain/booking/guestMoves'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, tenantRepos } from '../../repositories'
import type { BookingGuestRow } from '../../repositories/booking'
import type { AuthContext } from '../../security/authContext'
import { authorizeStaffBooking, loadForStaff } from './bookingAccess'
import { loadBookingSettings } from './bookingSettingsService'

export type { CheckInLookupDto, GuestMoveDto }

/** Pilgrims are checked in and out of bookings that are confirmed or already in the house. */
const AT_THE_HOTEL: readonly string[] = ['CONFIRMED', 'IN_HOUSE']

const CHANGE_KIND = { CHECK_IN: 'CHECKED_IN', CHECK_OUT: 'CHECKED_OUT', NO_SHOW: 'NO_SHOW' } as const

const REFUSALS: Record<MoveRefusal, () => Error> = {
  DETAILS_INCOMPLETE: () => new ValidationError('DETAILS_INCOMPLETE', 'Enter the pilgrim\'s full details before checking in'),
  GUEST_STATUS: () => new ConflictError('GUEST_STATUS', 'This is not possible for the pilgrim as they are now'),
  BEFORE_CHECK_IN: () => new ConflictError('BEFORE_CHECK_IN', 'The stay has not started yet'),
  STAY_OVER: () => new ConflictError('STAY_OVER', 'The stay is over'),
}

const toMoveDto = (guest: BookingGuestRow, bookingStatus: string): GuestMoveDto => ({
  guestId: guest.id,
  slotNo: guest.slotNo,
  status: guest.status as GuestStatus,
  checkedInAt: guest.checkedInAt?.toISOString() ?? null,
  checkedOutAt: guest.checkedOutAt?.toISOString() ?? null,
  bookingStatus: bookingStatus as BookingStatus,
})

/**
 * From which night a move frees the pilgrim's seat, or null: a check-out frees the nights after today's (a pilgrim who
 * checked in today keeps tonight — the room was used, and the history of who slept where stays); a no-show frees
 * them from today when the hotel's policy says so.
 */
async function nightsFreedFrom(repos: ReturnType<typeof bookingOrgRepos>, bookingId: string, guestId: string, move: GuestMove, noShowReleases: boolean, today: IsoDate): Promise<IsoDate | null> {
  if (move === 'NO_SHOW') return noShowReleases ? today : null
  if (move !== 'CHECK_OUT') return null
  const firstNight = await repos.guests.firstNight(bookingId, guestId)
  return firstNight !== null && firstNight >= today ? addDays(today, 1) : today
}

/** Who did it and when, on the slot itself. */
function stampsOf(move: GuestMove, userId: string, now: Date) {
  if (move === 'CHECK_IN') return { checkedInAt: now, checkedInBy: userId }
  if (move === 'CHECK_OUT') return { checkedOutAt: now, checkedOutBy: userId }
  return {}
}

/**
 * v7 §12 at the desk (`booking.checkIn` on the hotel): one pilgrim at a time, under the booking's row lock (the
 * booking's status follows from all its slots: IN_HOUSE from the first arrival, COMPLETED when everyone has left or
 * never came). Days are the hotel's. Repeating a move answers the pilgrim unchanged (a double scan at the desk).
 * Leaving before the last night frees the remaining nights (EARLY_CHECKOUT: the pilgrim's stays end today, a room
 * nobody sleeps in any more is let go from today); so does a no-show when the hotel's policy says so
 * (`noShowReleasesSeats`).
 */
async function moveGuest(ctx: AuthContext, bookingId: string, guestId: string, move: GuestMove): Promise<GuestMoveDto> {
  const row = await loadForStaff(ctx, bookingId, 'booking.checkIn')
  const [hotel, settings] = await Promise.all([tenantRepos(ctx.db, ctx.scope).hotels.findById(row.hotelId), loadBookingSettings(ctx.db, ctx.scope)])
  const now = ctx.now()
  const today = todayInTimezone(hotel?.timezone ?? 'UTC', now)
  return ctx.db.transaction(async (tx) => {
    const repos = bookingOrgRepos(tx, ctx.scope)
    const booking = await repos.records.findById(row.id, { forUpdate: true })
    const slot = await repos.guests.findSlot(row.id, guestId, { forUpdate: true })
    if (!booking || !slot) throw new NotFoundError('GUEST_NOT_FOUND')
    const before = slot.guest.status as GuestStatus
    const { to } = GUEST_MOVES[move]
    if (before === to) return toMoveDto(slot.guest, booking.status)
    if (!AT_THE_HOTEL.includes(booking.status)) throw new ConflictError('BOOKING_NOT_CONFIRMED', `Pilgrims of a booking that is ${booking.status} cannot be checked in or out`)
    const refusal = refuseMove(move, before, booking, today)
    if (refusal) throw REFUSALS[refusal]()

    const moved = await repos.guests.updateSlot(row.id, guestId, { status: to, ...stampsOf(move, ctx.identity.userId, now) })
    const releaseFrom = await nightsFreedFrom(repos, row.id, guestId, move, settings.noShowReleasesSeats, today)
    const freedClaims = releaseFrom ? await repos.guests.endStaysFrom(row.id, guestId, releaseFrom) : []
    if (freedClaims.length > 0) await repos.records.trimClaims(row.id, freedClaims, releaseFrom!, now)
    const bookingStatus = bookingStatusAfter(booking.status as BookingStatus, await repos.guests.statuses(row.id))
    if (bookingStatus !== booking.status) await repos.records.setStatus(row.id, bookingStatus, now)
    await repos.records.recordChange({
      bookingId: row.id,
      kind: move === 'CHECK_OUT' && freedClaims.length > 0 ? 'EARLY_CHECKOUT' : CHANGE_KIND[move],
      before: { slotNo: slot.guest.slotNo, status: before, bookingStatus: booking.status },
      after: { slotNo: slot.guest.slotNo, status: to, bookingStatus, ...(freedClaims.length > 0 ? { nightsFreedFrom: releaseFrom } : {}) },
      actor: { kind: 'staff', id: ctx.identity.userId },
    })
    return toMoveDto(moved!, bookingStatus)
  })
}

export const checkInGuest = (ctx: AuthContext, bookingId: string, guestId: string) => moveGuest(ctx, bookingId, guestId, 'CHECK_IN')
export const checkOutGuest = (ctx: AuthContext, bookingId: string, guestId: string) => moveGuest(ctx, bookingId, guestId, 'CHECK_OUT')
export const markGuestNoShow = (ctx: AuthContext, bookingId: string, guestId: string) => moveGuest(ctx, bookingId, guestId, 'NO_SHOW')

/**
 * The desk scans a receipt's QR code (v7 §17): the token names a confirmed booking, shown only to staff with
 * `booking.checkIn` on its hotel (any other token, or hotel, is "not found").
 */
export async function lookupReceipt(ctx: AuthContext, input: CheckInLookupInput): Promise<CheckInLookupDto> {
  const row = await bookingOrgRepos(ctx.db, ctx.scope).records.findByReceiptToken(input.receiptToken)
  if (!row) throw new NotFoundError('BOOKING_NOT_FOUND')
  await authorizeStaffBooking(ctx, row, 'booking.checkIn', { allowInactive: true })
  return { bookingId: row.id, bookingNo: row.bookingNo, hotelId: row.hotelId, status: row.status, checkIn: row.checkIn, checkOut: row.checkOut }
}
