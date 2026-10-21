/**
 * The front desk's response shapes (v7 §11–§12, §17): what a scanned receipt opens, a pilgrim after a move at the
 * desk, and the housekeeping tasks the bookings create. Shared by the API that builds them and the ops console.
 */
import type { BookingStatus, GuestStatus, HotelTaskKind, HotelTaskStatus } from '../constants/booking'

/** What the desk sees after scanning a receipt's QR code: which booking it is, to open it. */
export interface CheckInLookupDto { bookingId: string, bookingNo: string, hotelId: string, status: BookingStatus, checkIn: string, checkOut: string }

/** One pilgrim after a move at the desk (check-in, check-out, no-show), and the booking's status that follows. */
export interface GuestMoveDto {
  guestId: string
  slotNo: number
  status: GuestStatus
  checkedInAt: string | null
  checkedOutAt: string | null
  bookingStatus: BookingStatus
}

/** A housekeeping task as the hotel panel lists it (extra beds to set up or take away). */
export interface HotelTaskDto {
  id: string
  kind: HotelTaskKind
  status: HotelTaskStatus
  roomId: string
  roomNumber: string
  bookingId: string | null
  quantity: number
  dueDate: string
  doneAt: string | null
}
