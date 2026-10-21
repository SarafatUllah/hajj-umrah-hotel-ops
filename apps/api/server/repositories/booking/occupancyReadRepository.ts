import { sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import type { AgeGroup, BookingStatus, BookingType, GuestStatus, Occupancy } from '@hajj/contracts/constants/booking'
import type { IsoDate, NightRange } from '@hajj/contracts/utils/dates'
import type { HotelScope } from '../../security/scope'

/** Seats of one room on one night: confirmed (or in the house), and held by holds and requests not confirmed yet. */
export interface RoomNightSplit { roomId: string, night: IsoDate, booked: number, held: number }

/** Pilgrims arriving and leaving on one day (confirmed bookings). */
export interface DayMovement { day: IsoDate, arrivals: number, departures: number }

/** A live room claim on one night, with its booking. */
export interface NightClaim {
  bookingRoomId: string
  roomId: string
  bookingId: string
  bookingNo: string
  bookingStatus: BookingStatus
  bookingType: BookingType
  agencyId: string | null
  occupancy: Occupancy
  extraBeds: number
  checkIn: IsoDate
  checkOut: IsoDate
}

/** A pilgrim staying in a claim on one night; `fullName` from the booker's copy (null until entered; '' once erased). */
export interface NightGuest {
  bookingRoomId: string
  guestId: string
  slotNo: number
  ageGroup: AgeGroup
  status: GuestStatus
  fullName: string | null
}

/**
 * A booking whose claims hold seats now: a seat-holding status, and not a pending hold past its expiry (the rule of
 * `room_night_occupancy`, migration 0009, judged at the database's `now()`; a NULL expiry stays live, ticket 2).
 * `b` is the booking alias of every query below.
 */
const LIVE_BOOKING = sql`b.status in ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE') and not (b.status in ('HELD', 'REQUESTED') and coalesce(b.hold_expires_at <= now(), false))`
const CONFIRMED_BOOKING = sql`b.status in ('CONFIRMED', 'IN_HOUSE', 'COMPLETED')`

/**
 * The occupancy calendar's reads for one hotel (v7 §14): built only from `booking_room`, `booking_guest` and
 * `guest_stay` — seats counted with the same stays and liveness rule as `room_night_occupancy` (infants and removed
 * slots never take a seat), split by whether the booking is confirmed.
 */
export class OccupancyReadRepository {
  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {}

  /** Seats per room and night over `range`, split confirmed / held; room-nights without seats are absent. */
  async nightlySeats(range: NightRange): Promise<RoomNightSplit[]> {
    const rows = await this.db.execute<{ room_id: string, night: string, booked: number, held: number }>(sql`
      select br.room_id, (gs.check_in + d.i)::text as night,
        (count(*) filter (where b.status not in ('HELD', 'REQUESTED')))::integer as booked,
        (count(*) filter (where b.status in ('HELD', 'REQUESTED')))::integer as held
      from public.booking_room br
      join public.booking b on b.organization_id = br.organization_id and b.id = br.booking_id
      join public.guest_stay gs on gs.organization_id = br.organization_id and gs.booking_room_id = br.id
      join public.booking_guest g on g.organization_id = gs.organization_id and g.id = gs.booking_guest_id
      cross join lateral generate_series(greatest(0, ${range.from}::date - gs.check_in), least(gs.check_out - gs.check_in, ${range.to}::date - gs.check_in + 1) - 1) as d(i)
      where br.organization_id = ${this.scope.organizationId}::uuid
        and br.hotel_id = ${this.scope.hotelId}::uuid
        and br.check_in <= ${range.to}::date and br.check_out > ${range.from}::date
        and gs.check_in <= ${range.to}::date and gs.check_out > ${range.from}::date
        and br.status in ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE')
        and ${LIVE_BOOKING}
        and g.age_group <> 'INFANT'
        and g.status <> 'REMOVED'
      group by 1, 2`)
    return rows.map(r => ({ roomId: r.room_id, night: r.night, booked: r.booked, held: r.held }))
  }

  /**
   * Pilgrims of confirmed bookings (infants too) arriving and leaving per day of `range`, from their stays on claims
   * still confirmed (a released claim does not count); days without any are absent.
   */
  async movements(range: NightRange): Promise<DayMovement[]> {
    const stays = sql`
      from public.guest_stay gs
      join public.booking_room br on br.organization_id = gs.organization_id and br.id = gs.booking_room_id
      join public.booking b on b.organization_id = gs.organization_id and b.id = gs.booking_id
      join public.booking_guest g on g.organization_id = gs.organization_id and g.id = gs.booking_guest_id
      where gs.organization_id = ${this.scope.organizationId}::uuid and br.hotel_id = ${this.scope.hotelId}::uuid
        and ${CONFIRMED_BOOKING} and br.status in ('CONFIRMED', 'IN_HOUSE', 'COMPLETED') and g.status <> 'REMOVED'`
    const rows = await this.db.execute<{ day: string, arrivals: number, departures: number }>(sql`
      select m.day::text as day, sum(m.arrivals)::integer as arrivals, sum(m.departures)::integer as departures
      from (
        select gs.check_in as day, 1 as arrivals, 0 as departures ${stays} and gs.check_in between ${range.from}::date and ${range.to}::date
        union all
        select gs.check_out, 0, 1 ${stays} and gs.check_out between ${range.from}::date and ${range.to}::date
      ) m
      group by m.day`)
    return rows.map(r => ({ day: r.day, arrivals: r.arrivals, departures: r.departures }))
  }

  /** The live room claims covering `night`. */
  async claimsOn(night: IsoDate): Promise<NightClaim[]> {
    const rows = await this.db.execute<{ booking_room_id: string, room_id: string, booking_id: string, booking_no: string, booking_status: string, booking_type: string, agency_id: string | null, occupancy: string, extra_beds: number, check_in: string, check_out: string }>(sql`
      select br.id as booking_room_id, br.room_id, b.id as booking_id, b.booking_no, b.status as booking_status, b.booking_type, b.agency_id,
        br.occupancy, br.extra_beds, br.check_in::text as check_in, br.check_out::text as check_out
      from public.booking_room br
      join public.booking b on b.organization_id = br.organization_id and b.id = br.booking_id
      where br.organization_id = ${this.scope.organizationId}::uuid
        and br.hotel_id = ${this.scope.hotelId}::uuid
        and br.check_in <= ${night}::date and br.check_out > ${night}::date
        and br.status in ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE')
        and ${LIVE_BOOKING}
      order by br.room_id, b.booking_no`)
    return rows.map(r => ({
      bookingRoomId: r.booking_room_id,
      roomId: r.room_id,
      bookingId: r.booking_id,
      bookingNo: r.booking_no,
      bookingStatus: r.booking_status as BookingStatus,
      bookingType: r.booking_type as BookingType,
      agencyId: r.agency_id,
      occupancy: r.occupancy as Occupancy,
      extraBeds: r.extra_beds,
      checkIn: r.check_in,
      checkOut: r.check_out,
    }))
  }

  /** The pilgrims staying in the live claims on `night`, by slot (removed slots never). */
  async guestsOn(night: IsoDate): Promise<NightGuest[]> {
    const rows = await this.db.execute<{ booking_room_id: string, guest_id: string, slot_no: number, age_group: string, status: string, full_name: string | null }>(sql`
      select gs.booking_room_id, g.id as guest_id, g.slot_no, g.age_group, g.status, d.full_name
      from public.guest_stay gs
      join public.booking_room br on br.organization_id = gs.organization_id and br.id = gs.booking_room_id
      join public.booking b on b.organization_id = gs.organization_id and b.id = gs.booking_id
      join public.booking_guest g on g.organization_id = gs.organization_id and g.id = gs.booking_guest_id
      left join public.booking_guest_detail d on d.organization_id = g.organization_id and d.booking_guest_id = g.id
      where gs.organization_id = ${this.scope.organizationId}::uuid
        and br.hotel_id = ${this.scope.hotelId}::uuid
        and gs.check_in <= ${night}::date and gs.check_out > ${night}::date
        and br.status in ('HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE')
        and ${LIVE_BOOKING}
        and g.status <> 'REMOVED'
      order by gs.booking_room_id, g.slot_no`)
    return rows.map(r => ({ bookingRoomId: r.booking_room_id, guestId: r.guest_id, slotNo: r.slot_no, ageGroup: r.age_group as AgeGroup, status: r.status as GuestStatus, fullName: r.full_name }))
  }
}
