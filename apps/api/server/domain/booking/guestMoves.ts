import type { BookingStatus, GuestStatus } from '@hajj/contracts/constants/booking'
import type { IsoDate } from '@hajj/contracts/utils/dates'

/** What reception records for one pilgrim at the desk (v7 §12: each pilgrim checks in and out on their own). */
export type GuestMove = 'CHECK_IN' | 'CHECK_OUT' | 'NO_SHOW'

export type MoveRefusal = 'DETAILS_INCOMPLETE' | 'GUEST_STATUS' | 'BEFORE_CHECK_IN' | 'STAY_OVER'

/** Each move: the slot statuses it starts from, and where it leads. */
export const GUEST_MOVES: Readonly<Record<GuestMove, { from: readonly GuestStatus[], to: GuestStatus }>> = {
  CHECK_IN: { from: ['READY'], to: 'CHECKED_IN' },
  CHECK_OUT: { from: ['CHECKED_IN'], to: 'CHECKED_OUT' },
  NO_SHOW: { from: ['PENDING_DETAILS', 'READY'], to: 'NO_SHOW' },
}

/** A slot that is done with the stay: left, never came, or taken off the booking. */
const SETTLED: readonly GuestStatus[] = ['CHECKED_OUT', 'NO_SHOW', 'REMOVED']
const ARRIVED: readonly GuestStatus[] = ['CHECKED_IN', 'CHECKED_OUT']

/**
 * Why a move is refused for a slot on the hotel's `today`, or null. Checking in needs the pilgrim's full details
 * (v7 §12) and a day of the stay; a no-show is recorded from the check-in day on; checking out, any day after
 * checking in. A slot already where the move leads is not refused (the caller answers it unchanged).
 */
export function refuseMove(move: GuestMove, status: GuestStatus, stay: { checkIn: IsoDate, checkOut: IsoDate }, today: IsoDate): MoveRefusal | null {
  const { from, to } = GUEST_MOVES[move]
  if (status === to) return null
  if (move === 'CHECK_IN' && status === 'PENDING_DETAILS') return 'DETAILS_INCOMPLETE'
  if (!from.includes(status)) return 'GUEST_STATUS'
  if (move !== 'CHECK_OUT' && today < stay.checkIn) return 'BEFORE_CHECK_IN'
  if (move === 'CHECK_IN' && today >= stay.checkOut) return 'STAY_OVER'
  return null
}

/**
 * The booking's status once its slots are as given (v7 §7): IN_HOUSE from the first arrival, COMPLETED when every
 * slot still on the booking has left or never came; otherwise unchanged.
 */
export function bookingStatusAfter(current: BookingStatus, slots: readonly GuestStatus[]): BookingStatus {
  const onBooking = slots.filter(s => s !== 'REMOVED')
  if (onBooking.length > 0 && onBooking.every(s => SETTLED.includes(s))) return 'COMPLETED'
  return slots.some(s => ARRIVED.includes(s)) ? 'IN_HOUSE' : current
}
