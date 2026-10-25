import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { booking, bookingRoom, room } from '@hajj/db/schema'
import { type Occupancy, PENDING_BOOKING_STATUSES, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import type { IsoDate, NightRange } from '@hajj/contracts/utils/dates'
import type { HotelScope } from '../../security/scope'
import { HotelQuery } from '../base/scopedQuery'

export interface LiveRoomClaim {
  bookingId: string
  bookingNo: string
  roomId: string
  /** `a:<agencyId>` or `b:<bookingId>`: who owns the room on these nights. */
  ownerKey: string
  occupancy: Occupancy
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

  /** Live claims on `roomIds` (null = every room of the hotel) overlapping the nights `from`..`to` (`to` null = every later night). */
  async liveClaims(roomIds: readonly string[] | null, from: IsoDate, to: IsoDate | null): Promise<LiveRoomClaim[]> {
    if (roomIds?.length === 0) return []
    const rows = await this.db
      .select({ bookingId: bookingRoom.bookingId, bookingNo: booking.bookingNo, roomId: bookingRoom.roomId, ownerKey: bookingRoom.ownerKey, occupancy: bookingRoom.occupancy, checkIn: bookingRoom.checkIn, checkOut: bookingRoom.checkOut, extraBeds: bookingRoom.extraBeds })
      .from(bookingRoom)
      .innerJoin(booking, this.q.cond(booking, eq(booking.id, bookingRoom.bookingId)))
      .where(this.q.cond(bookingRoom, roomIds ? inArray(bookingRoom.roomId, [...new Set(roomIds)]) : undefined, gt(bookingRoom.checkOut, from), to === null ? undefined : lte(bookingRoom.checkIn, to), liveClaim))
      .orderBy(bookingRoom.roomId, bookingRoom.checkIn, bookingRoom.bookingId)
    return rows.map(r => ({ ...r, occupancy: r.occupancy as Occupancy }))
  }

  /**
   * Seated pilgrims per room and night over `range` (the `room_night_occupancy` function; `roomIds` null = every room);
   * room-nights without seats are absent. `exceptBookingId`: that booking's seats are not counted (a date change).
   */
  async seatsUsed(roomIds: readonly string[] | null, range: NightRange, exceptBookingId: string | null = null): Promise<RoomNightSeats[]> {
    if (roomIds?.length === 0) return []
    const ids = roomIds ? sql`array[${sql.join([...new Set(roomIds)].map(id => sql`${id}::uuid`), sql`, `)}]` : sql`null::uuid[]`
    const rows = await this.db.execute<{ room_id: string, night: string, seats_used: number }>(sql`
      select room_id, night::text as night, seats_used
      from room_night_occupancy(${this.scope.organizationId}::uuid, ${this.scope.hotelId}::uuid, ${range.from}::date, ${range.to}::date, ${ids}, ${exceptBookingId}::uuid)
      order by room_id, night`)
    return rows.map(r => ({ roomId: r.room_id, night: r.night, seatsUsed: r.seats_used }))
  }

  /**
   * Persons the agency holds in this hotel per night over `range` (v7 §10 quota): seated pilgrims of its live
   * bookings — HELD and REQUESTED included, extra beds included, infants and removed slots never — counted from
   * the same stays and liveness rule as `room_night_occupancy`. Nights without anyone are absent. `exceptBookingId`:
   * that booking's pilgrims are not counted (a date change gives up its nights).
   */
  async agencyPersonsByNight(agencyId: string, range: NightRange, exceptBookingId: string | null = null): Promise<Map<IsoDate, number>> {
    const rows = await this.db.execute<{ night: string, persons: number }>(sql`
      select (gs.check_in + d.i)::text as night, count(*)::integer as persons
      from public.booking b
      join public.booking_guest g on g.organization_id = b.organization_id and g.booking_id = b.id
      join public.guest_stay gs on gs.organization_id = g.organization_id and gs.booking_id = b.id and gs.booking_guest_id = g.id
      cross join lateral generate_series(greatest(0, ${range.from}::date - gs.check_in), least(gs.check_out - gs.check_in, ${range.to}::date - gs.check_in + 1) - 1) as d(i)
      where b.organization_id = ${this.scope.organizationId}::uuid
        and b.agency_id = ${agencyId}::uuid
        and b.hotel_id = ${this.scope.hotelId}::uuid
        and b.status in ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE')
        and b.check_in <= ${range.to}::date and b.check_out > ${range.from}::date
        and (${exceptBookingId}::uuid is null or b.id <> ${exceptBookingId}::uuid)
        and not (b.status in ('HELD', 'REQUESTED') and coalesce(b.hold_expires_at <= now(), false))
        and g.age_group <> 'INFANT'
        and g.status <> 'REMOVED'
        and gs.check_in <= ${range.to}::date and gs.check_out > ${range.from}::date
      group by 1`)
    return new Map(rows.map(r => [r.night, r.persons]))
  }

  /**
   * v7 §10 step 2: row-locks the rooms in id order (the one lock order every hold and inventory change uses, so
   * they never deadlock) and returns the ids found in this hotel. `FOR NO KEY UPDATE` excludes other holds and the
   * inventory changes' `FOR UPDATE` without blocking unrelated inserts that reference a room. Inside a transaction only.
   */
  async lockRooms(roomIds: readonly string[]): Promise<string[]> {
    if (roomIds.length === 0) return []
    const rows = await this.db.select({ id: room.id }).from(room)
      .where(this.q.cond(room, inArray(room.id, [...new Set(roomIds)])))
      .orderBy(asc(room.id))
      .for('no key update')
    return rows.map(r => r.id)
  }

  /**
   * v7 §10 step 1: takes the agency's quota lock in this hotel (a transaction-scoped advisory lock on the
   * organization, hotel and agency) BEFORE the room locks, so two holds of one agency never both pass the quota,
   * then reads the persons it holds per night (`agencyPersonsByNight`, leaving `exceptBookingId` out) under that lock.
   * Inside a transaction only.
   */
  async lockAgencyQuota(agencyId: string, range: NightRange, exceptBookingId: string | null = null): Promise<Map<IsoDate, number>> {
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${this.scope.organizationId}:${this.scope.hotelId}:${agencyId}`}, 0))`)
    return this.agencyPersonsByNight(agencyId, range, exceptBookingId)
  }
}
