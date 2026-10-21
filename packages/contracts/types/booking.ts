/**
 * The booking API's response shapes (v7 §7–§12), shared by the API that builds them and the frontends that read them.
 * Dates are `YYYY-MM-DD` hotel dates; timestamps ISO strings; money in halalas.
 */
import type { AgeGroup, BookingStatus, Gender, Occupancy } from '../constants/booking'
import type { PriceLineKind, PriceSource } from '../constants/pricing'

/** A booking's room claim as shown to people: the room's number and floor. */
export interface BookingRoomLine {
  roomId: string
  roomNumber: string
  floorLevel: number
  roomTypeId: string
  occupancy: Occupancy
  extraBeds: number
  status: string
  checkIn: string
  checkOut: string
}

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

/** A receipt line (v7 §11: extra beds on their own line): the same kind, room type, quantity and price over its nights. */
export interface ReceiptLine { kind: PriceLineKind, roomTypeId: string | null, quantity: number, unitAmountHalalas: number, nights: number, amountHalalas: number, vatIncluded: boolean }

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

export interface StayOptionRoom { roomId: string, roomNumber: string, floorLevel: number, roomTypeId: string, occupancy: Occupancy, seats: number, extraBeds: number, existing: boolean }

/** One complete option (v7 §9.2 step 7), priced on its actual rooms (empty seats never charged). */
export interface StayOption { rooms: StayOptionRoom[], newRooms: number, emptySeats: number, extraBeds: number, totalHalalas: number, priceSource: PriceSource }

export interface StaySearchResult {
  options: StayOption[]
  /** How many more persons the agency may still hold on every night of the stay (v7 §10); null = no quota. */
  quotaHeadroom: number | null
}

export interface GuestDetailsDto {
  fullName: string
  gender: Gender | null
  nationality: string | null
  /** Null for a customer's view (D-P2-27b). */
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
  /** The retention sweep erased this copy (ticket 4): the slot keeps its history, not its personal data. */
  | { code: 'DETAILS_ERASED' }
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
