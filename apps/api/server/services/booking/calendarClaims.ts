import type { BookingStatus } from '@hajj/contracts/constants/booking'
import type { BookingInventoryStatus } from '@hajj/contracts/constants/inventory'
import { addDays, type IsoDate, type NightRange } from '@hajj/contracts/utils/dates'
import { bookingRepos } from '../../repositories'
import type { HotelScope } from '../../security/scope'
import { findAgencyNames } from '../accounts'

type Db = Parameters<typeof bookingRepos>[0]

/** How a claim shows on the room calendar (UI-UX §19): in the house is occupied, confirmed is booked, held or requested is held. */
const SHOWN: Partial<Record<BookingStatus, BookingInventoryStatus>> = { HELD: 'HELD', REQUESTED: 'HELD', CONFIRMED: 'BOOKED', IN_HOUSE: 'OCCUPIED' }

/** A booking on a room, for the room calendar: its nights as first and last (inclusive), and whose it is. */
export interface RoomCalendarClaim {
  roomId: string
  bookingId: string
  bookingNo: string
  status: BookingInventoryStatus
  agencyName: string | null
  checkIn: IsoDate
  checkOut: IsoDate
  /** The first and last nights the claim holds the room. */
  from: IsoDate
  to: IsoDate
}

/**
 * The live bookings on the hotel's rooms over `range` (the booking module's answer to the room calendar): two
 * statements whatever the size — the claims, then their agencies' names.
 */
export async function roomCalendarClaims(db: Db, scope: HotelScope, range: NightRange): Promise<RoomCalendarClaim[]> {
  const rows = await bookingRepos(db, scope).occupancy.calendarClaims(range)
  const names = await findAgencyNames(db, scope, [...new Set(rows.flatMap(r => (r.agencyId ? [r.agencyId] : [])))])
  return rows.flatMap((r) => {
    const status = SHOWN[r.claimStatus]
    if (!status) return []
    return [{ roomId: r.roomId, bookingId: r.bookingId, bookingNo: r.bookingNo, status, agencyName: r.agencyId ? names.get(r.agencyId) ?? null : null, checkIn: r.checkIn, checkOut: r.checkOut, from: r.checkIn, to: addDays(r.checkOut, -1) }]
  })
}
