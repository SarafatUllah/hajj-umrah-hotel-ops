import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { booking, bookingRoom } from '@hajj/db/schema'
import { PENDING_BOOKING_STATUSES, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import type { IsoDate, NightRange } from '@hajj/contracts/utils/dates'
import type { HotelScope } from '../../security/scope'
import { HotelQuery } from '../base/scopedQuery'

export interface LiveRoomClaim {
  bookingId: string
  bookingNo: string
  roomId: string
  checkIn: IsoDate
  checkOut: IsoDate
  extraBeds: number
}

export interface RoomNightSeats {
  roomId: string
  night: IsoDate
  seatsUsed: number
}

/**
 * A claim that holds seats right now: a seat-holding status, and not a pending hold already past its
 * expiry (the same rule as `room_night_occupancy`, migration 0009; a NULL expiry stays live, ticket 2).
 */
const liveClaim = and(
  inArray(bookingRoom.status, [...SEAT_HOLDING_STATUSES]),
  sql`not (${inArray(booking.status, [...PENDING_BOOKING_STATUSES])} and coalesce(${booking.holdExpiresAt} <= now(), false))`,
)

/**
 * The booking module's hotel-scoped reads of room claims and seat counts, for checks that must see what
 * bookings hold (inventory changes, holds, the calendar). Every statement carries the organization AND
 * hotel predicate on every table it reads.
 */
export class BookingInventoryRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  /** Live claims on `roomIds` overlapping the nights `from`..`to` (`to` null = every later night). */
  async liveClaims(roomIds: readonly string[], from: IsoDate, to: IsoDate | null): Promise<LiveRoomClaim[]> {
    if (roomIds.length === 0) return []
    return this.db
      .select({ bookingId: bookingRoom.bookingId, bookingNo: booking.bookingNo, roomId: bookingRoom.roomId, checkIn: bookingRoom.checkIn, checkOut: bookingRoom.checkOut, extraBeds: bookingRoom.extraBeds })
      .from(bookingRoom)
      .innerJoin(booking, this.q.cond(booking, eq(booking.id, bookingRoom.bookingId)))
      .where(this.q.cond(bookingRoom, inArray(bookingRoom.roomId, [...new Set(roomIds)]), gt(bookingRoom.checkOut, from), to === null ? undefined : lte(bookingRoom.checkIn, to), liveClaim))
      .orderBy(bookingRoom.roomId, bookingRoom.checkIn, bookingRoom.bookingId)
  }

  /** Seated pilgrims per room and night over `range` (the `room_night_occupancy` function); room-nights without seats are absent. */
  async seatsUsed(roomIds: readonly string[], range: NightRange): Promise<RoomNightSeats[]> {
    if (roomIds.length === 0) return []
    const ids = sql`array[${sql.join([...new Set(roomIds)].map(id => sql`${id}::uuid`), sql`, `)}]`
    const rows = await this.db.execute<{ room_id: string, night: string, seats_used: number }>(sql`
      select room_id, night::text as night, seats_used
      from room_night_occupancy(${this.scope.organizationId}::uuid, ${this.scope.hotelId}::uuid, ${range.from}::date, ${range.to}::date, ${ids})
      order by room_id, night`)
    return rows.map(r => ({ roomId: r.room_id, night: r.night, seatsUsed: r.seats_used }))
  }
}
