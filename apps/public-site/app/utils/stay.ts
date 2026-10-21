import type { BookingType, ChildSide, Occupancy } from '@hajj/contracts/constants/booking'
import type { StayOption } from '@hajj/contracts/types/booking'

/** The booking form as people fill it: a family gives its total; a group its men, women and children. */
export interface StayForm {
  hotelId: string
  checkIn: string
  checkOut: string
  bookingType: BookingType
  totalCount: number
  maleCount: number
  femaleCount: number
  childCount: number
  infantCount: number
  childSide: ChildSide
}

export interface ChosenRoom { roomId: string, occupancy: Occupancy, seats: number, extraBeds: number }

/** The search request for the form (`customerStaySearchSchema`): a group's total is its men, women and children. */
export function searchRequestOf(form: StayForm) {
  const base = { hotelId: form.hotelId, bookingType: form.bookingType, checkIn: form.checkIn, checkOut: form.checkOut, infantCount: form.infantCount }
  if (form.bookingType === 'FAMILY') return { ...base, totalCount: form.totalCount }
  return {
    ...base,
    maleCount: form.maleCount,
    femaleCount: form.femaleCount,
    childCount: form.childCount,
    totalCount: form.maleCount + form.femaleCount + form.childCount,
    ...(form.childCount > 0 ? { childSide: form.childSide } : {}),
  }
}

/** The rooms of the chosen option, as the request sends them back. */
export function chosenRoomsOf(option: StayOption): ChosenRoom[] {
  return option.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))
}

const FIRST_PRINTABLE = 0x20

/** Where to go after signing in: only a path of this site (never another origin, nor one a browser would read so). */
export function safeRedirect(target: unknown, fallback = '/bookings'): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return fallback
  // `//host`, `/\host` and control characters (browsers drop tabs and newlines: `/\t/host` is `//host`).
  const controlled = [...target].some(character => character.charCodeAt(0) < FIRST_PRINTABLE)
  return controlled || target.startsWith('//') || target.includes('\\') ? fallback : target
}
