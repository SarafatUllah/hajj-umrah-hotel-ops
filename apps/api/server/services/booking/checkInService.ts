import type { BookingStatus, GuestStatus } from '@hajj/contracts/constants/booking'
import type { CheckInLookupInput } from '@hajj/contracts/schemas/booking'
import { todayInTimezone } from '@hajj/contracts/utils/dates'
import { bookingStatusAfter, GUEST_MOVES, type GuestMove, type MoveRefusal, refuseMove } from '../../domain/booking/guestMoves'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, tenantRepos } from '../../repositories'
import type { BookingGuestRow } from '../../repositories/booking'
import type { AuthContext } from '../../security/authContext'
import { authorizeStaffBooking, loadForStaff } from './bookingAccess'

/** What the desk sees after scanning a receipt's QR code: which booking it is, to open it. */
export interface CheckInLookupDto { bookingId: string, bookingNo: string, hotelId: string, status: string, checkIn: string, checkOut: string }

/** One pilgrim after a move at the desk, and the booking's status that follows from it. */
export interface GuestMoveDto {
  guestId: string
  slotNo: number
  status: GuestStatus
  checkedInAt: string | null
  checkedOutAt: string | null
  bookingStatus: BookingStatus
}

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
 */
async function moveGuest(ctx: AuthContext, bookingId: string, guestId: string, move: GuestMove): Promise<GuestMoveDto> {
  const row = await loadForStaff(ctx, bookingId, 'booking.checkIn')
  const hotel = await tenantRepos(ctx.db, ctx.scope).hotels.findById(row.hotelId)
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
    const bookingStatus = bookingStatusAfter(booking.status as BookingStatus, await repos.guests.statuses(row.id))
    if (bookingStatus !== booking.status) await repos.records.setStatus(row.id, bookingStatus, now)
    await repos.records.recordChange({
      bookingId: row.id,
      kind: CHANGE_KIND[move],
      before: { slotNo: slot.guest.slotNo, status: before, bookingStatus: booking.status },
      after: { slotNo: slot.guest.slotNo, status: to, bookingStatus },
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
