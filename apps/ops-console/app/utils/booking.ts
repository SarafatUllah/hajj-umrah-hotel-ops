import { type BookingStatus, CONFIRMED_BOOKING_STATUSES, GUEST_TO_COME_STATUSES, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import type { Permission } from '@hajj/contracts/constants/permissions'
import type { IsoDate } from '@hajj/contracts/utils/dates'

type Can = (permission: Permission) => boolean
interface BookingState { status: BookingStatus, checkIn: IsoDate, checkOut: IsoDate }
/** For the desk: also how many pilgrims the booking still has (removed ones not counted). */
interface DeskState extends BookingState { pilgrims: number }

const isIn = (statuses: readonly string[], status: string) => statuses.includes(status)
/** Changed before anyone arrives: still holding its places, not yet in the house. */
const CHANGEABLE: readonly BookingStatus[] = ['HELD', 'REQUESTED', 'CONFIRMED']
const AT_THE_HOTEL: readonly BookingStatus[] = ['CONFIRMED', 'IN_HOUSE']
const TO_COME: readonly string[] = GUEST_TO_COME_STATUSES

/**
 * What the console offers on a booking (v7 §7, §12). Only an offer: the API decides, and says why when it refuses. An
 * inactive hotel (`hotelActive` false) takes no change but the booking's cancellation; `guests` null: not known (yet).
 */
export interface BookingActions {
  confirm: boolean
  cancel: boolean
  changeDates: boolean
  addPilgrims: boolean
  editDetails: boolean
  scans: boolean
  receipt: boolean
}

export function bookingActionsOf(booking: BookingState, guests: ReadonlyArray<{ status: string }> | null, can: Can, hotelActive: boolean): BookingActions {
  const holding = isIn(SEAT_HOLDING_STATUSES, booking.status)
  const changeable = isIn(CHANGEABLE, booking.status)
  const write = (permission: Permission) => hotelActive && can(permission)
  return {
    confirm: (booking.status === 'HELD' || booking.status === 'REQUESTED') && write('booking.create'),
    cancel: changeable && can('booking.cancel'),
    // A new stay is a new allocation: only while nobody has arrived (or left, or failed to come).
    changeDates: changeable && !!guests && guests.every(g => isIn([...TO_COME, 'REMOVED'], g.status)) && write('booking.edit'),
    addPilgrims: changeable && write('booking.edit'),
    editDetails: holding && write('booking.edit'),
    scans: holding && write('booking.edit'),
    receipt: isIn(CONFIRMED_BOOKING_STATUSES, booking.status),
  }
}

/** What the desk is offered on one pilgrim; `detailsNeeded`: arriving today or later, but nothing to check in with. */
export interface GuestActions { checkIn: boolean, checkOut: boolean, noShow: boolean, remove: boolean, move: boolean, detailsNeeded: boolean }

/** At an inactive hotel (`hotelActive` false) the desk does nothing: no move of any pilgrim goes through. */
export function guestActionsOf(guest: { status: string, roomNumber: string | null }, booking: DeskState, today: IsoDate, can: Can, hotelActive: boolean): GuestActions {
  if (!hotelActive) return { checkIn: false, checkOut: false, noShow: false, remove: false, move: false, detailsNeeded: false }
  const atHotel = isIn(AT_THE_HOTEL, booking.status)
  const holding = isIn(SEAT_HOLDING_STATUSES, booking.status)
  const duringStay = booking.checkIn <= today && today < booking.checkOut
  const desk = atHotel && can('booking.checkIn')
  return {
    checkIn: desk && guest.status === 'READY' && duringStay,
    checkOut: desk && guest.status === 'CHECKED_IN',
    noShow: desk && isIn(TO_COME, guest.status) && today >= booking.checkIn,
    // The last pilgrim is not removed: the booking is cancelled instead (the API's rule).
    remove: holding && isIn(TO_COME, guest.status) && booking.pilgrims > 1 && can('booking.cancel'),
    move: holding && isIn([...TO_COME, 'CHECKED_IN'], guest.status) && today < booking.checkOut && !!guest.roomNumber && can('booking.edit'),
    detailsNeeded: atHotel && guest.status === 'PENDING_DETAILS' && today < booking.checkOut,
  }
}

/**
 * The queries a booking's change shows in (one list, so a new screen is never missed): the bookings lists, the
 * occupancy calendar and its day, the desk's arrivals and departures, housekeeping, and the quotes (a booking marks
 * its quote ACCEPTED); with `bookingId`, the booking's own page (its detail, pilgrims and receipt) too.
 */
export function bookingChangeKeys(bookingId?: string): string[][] {
  const own = bookingId ? [['booking', bookingId], ['booking-guests', bookingId], ['booking-receipt', bookingId]] : []
  return [...own, ['bookings'], ['occupancy'], ['occupancy-day'], ['tasks'], ['quotes'], ['quote']]
}
