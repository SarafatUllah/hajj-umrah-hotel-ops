import type { BookingStatus, GuestStatus } from '@hajj/contracts/constants/booking'
import type { MoveGuestsInput } from '@hajj/contracts/schemas/booking'
import { type IsoDate, maxIsoDate, todayInTimezone } from '@hajj/contracts/utils/dates'
import { effectiveBookingStatus } from '../../domain/booking/bookingView'
import { refuseRoomMove, type RoomMoveRefusal } from '../../domain/booking/roomMoves'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, bookingRepos } from '../../repositories'
import type { AuthContext } from '../../security/authContext'
import { bookableHotel } from '../../security/authorize'
import { loadForStaff } from './bookingAccess'
import { type BookingDetailDto, bookingDetail } from './bookingService'
import { claimsOwnerKey, loadStayRooms } from './stayFacts'

/** Bookings whose pilgrims can be moved: holding seats now (a pending hold past its expiry holds none). */
const MOVABLE_BOOKINGS: readonly BookingStatus[] = ['HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE']
/** Pilgrims who still sleep in the hotel (or will). */
const MOVABLE_SLOTS: readonly string[] = ['PENDING_DETAILS', 'READY', 'CHECKED_IN'] satisfies GuestStatus[]

const REFUSALS: Record<RoomMoveRefusal, () => Error> = {
  SAME_ROOM: () => new ValidationError('SAME_ROOM', 'Some of them already sleep in this room'),
  MIXED_SIDES: () => new ValidationError('MIXED_SIDES', 'Move one side at a time (men, women or a family)'),
  ROOM_NOT_SELLABLE: () => new ConflictError('ROOM_NOT_SELLABLE', 'The room cannot be used on some of these nights'),
  ROOM_TAKEN: () => new ConflictError('ROOM_TAKEN', 'The room belongs to someone else, or to the other side, on some of these nights'),
  NOT_ENOUGH_SEATS: () => new ConflictError('NOT_ENOUGH_SEATS', 'The room has not enough free seats on some of these nights'),
}

/** A move starts on a night of the stay, today or later. */
function assertMoveDay(from: IsoDate, today: IsoDate, stay: { checkIn: string, checkOut: string }): void {
  if (from < today) throw new ValidationError('MOVE_IN_PAST', 'A move starts today or later')
  if (from < stay.checkIn || from >= stay.checkOut) throw new ValidationError('MOVE_OUTSIDE_STAY', 'A move starts on a night of the stay')
}

/**
 * v7 §12 room move (staff, `booking.edit`: maintenance, a complaint, an inventory change): the chosen pilgrims sleep in
 * another room from a night on — the hotel's day, by default today (or the check-in when the stay has not begun) —
 * until the booking's check-out. In v7 §10's lock order (the rooms involved by id, then the booking) the target room
 * is checked for every night left: sellable, claimed by nobody but the booking's owner (an agency's group room: the
 * agency's) with the same occupancy, a free seat for each of them who takes one. Their stays split at that night (the
 * earlier part stays where it was: who slept where is history); the booking claims the room for the rest of its stay
 * (its own claim when it has one); a room nobody sleeps in any more from then on is let go; ROOM_MOVED is logged.
 * The price does not change (the hotel's move).
 */
export async function moveGuests(ctx: AuthContext, bookingId: string, input: MoveGuestsInput): Promise<BookingDetailDto> {
  const row = await loadForStaff(ctx, bookingId, 'booking.edit')
  const { hotel, scope: hotelScope } = await bookableHotel(ctx.db, ctx.scope, row.hotelId)
  const now = ctx.now()
  const today = todayInTimezone(hotel.timezone, now)
  const from: IsoDate = input.from ?? maxIsoDate(today, row.checkIn)
  assertMoveDay(from, today, row)

  const changed = await ctx.db.transaction(async (tx) => {
    const repos = bookingOrgRepos(tx, ctx.scope)
    // The rooms they sleep in now, read before the locks only to know which rooms to lock (in id order).
    const before = await repos.guests.staysFrom(row.id, input.guestIds, from)
    const locked = await bookingRepos(tx, hotelScope).inventory.lockRooms([...new Set([input.roomId, ...before.map(s => s.roomId)])])
    if (!locked.includes(input.roomId)) throw new NotFoundError('ROOM_NOT_FOUND')
    await bookingRepos(tx, hotelScope).bookings.expireLapsedHolds(locked, now)
    const booking = await repos.records.findById(row.id, { forUpdate: true })
    if (!booking) throw new NotFoundError('BOOKING_NOT_FOUND')
    const status = effectiveBookingStatus({ status: booking.status as BookingStatus, holdExpiresAt: booking.holdExpiresAt }, now)
    if (!MOVABLE_BOOKINGS.includes(status)) throw new ConflictError('BOOKING_NOT_CHANGEABLE', `The pilgrims of a booking that is ${status} cannot be moved`)
    assertMoveDay(from, today, booking)

    const slots = await Promise.all(input.guestIds.map(id => repos.guests.findSlot(booking.id, id, { forUpdate: true })))
    if (slots.some(s => !s)) throw new NotFoundError('GUEST_NOT_FOUND')
    // Read again under the booking's lock: another change of the booking may have moved them meanwhile.
    const stays = await repos.guests.staysFrom(booking.id, input.guestIds, from)
    const staying = new Set(stays.map(s => s.guestId))
    if (slots.some(s => !MOVABLE_SLOTS.includes(s!.guest.status) || !staying.has(s!.guest.id))) throw new ConflictError('GUEST_STATUS', 'Only pilgrims still staying can be moved')
    if (stays.some(s => !locked.includes(s.roomId))) throw new ConflictError('BOOKING_CHANGED', 'The booking changed meanwhile; try again')

    const ownerKey = claimsOwnerKey(booking)
    const { rooms } = await loadStayRooms({ db: tx, hotelScope, stay: { checkIn: from, checkOut: booking.checkOut }, roomIds: [input.roomId] })
    const seated = slots.filter(s => s!.guest.ageGroup !== 'INFANT').length
    const refusal = refuseRoomMove({ target: rooms.find(r => r.id === input.roomId) ?? null, targetRoomId: input.roomId, stays, ownerKey, seated })
    if (refusal) throw REFUSALS[refusal]()

    const claimId = await repos.records.claimForMove(booking, input.roomId, stays[0]!.occupancy, from, ownerKey.startsWith('a:'), now)
    const sourceClaims = await repos.guests.moveStaysFrom(booking.id, input.guestIds, from, claimId)
    await repos.records.trimClaims(booking.id, sourceClaims, from, now)
    await repos.records.recordChange({
      bookingId: booking.id,
      kind: 'ROOM_MOVED',
      before: { roomIds: [...new Set(stays.map(s => s.roomId))] },
      after: { roomId: input.roomId, from, slotNos: slots.map(s => s!.guest.slotNo) },
      actor: { kind: 'staff', id: ctx.identity.userId },
    })
    return booking
  }).catch(rethrowDbError)
  return bookingDetail(ctx.db, ctx.scope, changed, now)
}
