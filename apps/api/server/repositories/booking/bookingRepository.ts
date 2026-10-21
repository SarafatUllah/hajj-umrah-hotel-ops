import { type SQL, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { booking, bookingChange, bookingGuest, bookingPriceLine, bookingRoom, guestStay } from '@hajj/db/schema'
import type { AgeGroup, Gender, Occupancy } from '@hajj/contracts/constants/booking'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { HotelScope, OrganizationScope } from '../../security/scope'
import { HotelQuery, OrgQuery } from '../base/scopedQuery'

export type BookingRow = typeof booking.$inferSelect
type NewBookingRow = Omit<typeof booking.$inferInsert, 'organizationId' | 'hotelId' | 'id' | 'createdAt' | 'updatedAt'>
type NewPriceLine = Omit<typeof bookingPriceLine.$inferInsert, 'organizationId' | 'bookingId' | 'id' | 'createdAt'>

/** Everything a new pending booking writes (v7 §10 step 5). */
export interface NewHold {
  booking: NewBookingRow
  /** The rooms claimed; `ownedByAgency`: the booking's agency owns the room (GROUP), otherwise the booking itself. */
  rooms: ReadonlyArray<{ roomId: string, occupancy: Occupancy, extraBeds: number, ownedByAgency: boolean }>
  /** The pilgrim slots and the room each sleeps in for the whole stay. */
  guests: ReadonlyArray<{ slotNo: number, gender: Gender | null, ageGroup: AgeGroup, isExtraBed: boolean, roomId: string }>
  priceLines: readonly NewPriceLine[]
  actor: { kind: ActorKind, id: string | null }
}

/** The sweep expires at most this many bookings per statement, then goes on (no long statement on a mass lapse). */
const SWEEP_BATCH = 500

/**
 * Pending bookings whose hold lapsed become EXPIRED, each with a `booking_change` row (actor: system), in one
 * statement. "Lapsed" is judged at the later of the application's `now` and the database's clock, so whatever the
 * seat count (`room_night_occupancy`, database time) already treats as free is expired here too. Rows another
 * transaction holds are skipped (a confirmation in progress, or another expiry): whoever holds them decides, and
 * the sweep never waits on a hold (no lock cycle). `extra` narrows the bookings (hotel, rooms).
 */
async function expireLapsed(db: DbOrTx, organizationId: string, now: Date, extra: SQL, limit?: number): Promise<string[]> {
  const at = sql`greatest(${now.toISOString()}::timestamptz, clock_timestamp())`
  const rows = await db.execute<{ booking_id: string }>(sql`
    with lapsed as (
      select b.id, b.status from public.booking b
      where b.organization_id = ${organizationId}::uuid and b.status in ('HELD', 'REQUESTED') and b.hold_expires_at <= ${at} ${extra}
      order by b.id
      ${limit === undefined ? sql`` : sql`limit ${limit}`}
      for update of b skip locked
    ), expired as (
      update public.booking b set status = 'EXPIRED', updated_at = ${at}
      from lapsed
      where b.organization_id = ${organizationId}::uuid and b.id = lapsed.id and b.status in ('HELD', 'REQUESTED')
      returning b.id, lapsed.status as was
    )
    insert into public.booking_change (organization_id, booking_id, kind, before_data, after_data, actor_kind)
    select ${organizationId}::uuid, id, 'EXPIRED', jsonb_build_object('status', was), jsonb_build_object('status', 'EXPIRED'), 'system' from expired
    returning booking_id`)
  return rows.map(r => r.booking_id).sort()
}

/** The booking module's hotel-scoped booking writes (hold creation, hold expiry on locked rooms). */
export class BookingRepository {
  readonly #q: HotelQuery
  readonly #org: OrgQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.#q = new HotelQuery(db, scope)
    this.#org = new OrgQuery(db, scope)
  }

  /**
   * Writes a pending booking: the booking, one claim per room (its own rows even in a room the agency already
   * holds), one slot per pilgrim with its stay in its room, the frozen price lines and the CREATED change. The
   * database checks the rest (one owner and occupancy per room-night, stays within claims at commit).
   */
  async insertHold(hold: NewHold): Promise<BookingRow> {
    const [row] = await this.#q.insert(booking, hold.booking).returning()
    const created = row!
    const claims = await this.#q.insertMany(bookingRoom, hold.rooms.map(r => ({
      bookingId: created.id,
      roomId: r.roomId,
      ownerAgencyId: r.ownedByAgency ? created.agencyId : null,
      ownerBookingId: r.ownedByAgency ? null : created.id,
      occupancy: r.occupancy,
      checkIn: created.checkIn,
      checkOut: created.checkOut,
      status: created.status,
      extraBeds: r.extraBeds,
    }))).returning({ id: bookingRoom.id, roomId: bookingRoom.roomId })
    const claimOfRoom = new Map(claims.map(c => [c.roomId, c.id]))

    const guests = await this.#org.insertMany(bookingGuest, hold.guests.map(g => ({ bookingId: created.id, slotNo: g.slotNo, gender: g.gender, ageGroup: g.ageGroup, isExtraBed: g.isExtraBed })))
      .returning({ id: bookingGuest.id, slotNo: bookingGuest.slotNo })
    const roomOfSlot = new Map(hold.guests.map(g => [g.slotNo, g.roomId]))
    await this.#org.insertMany(guestStay, guests.map(g => ({ bookingId: created.id, bookingGuestId: g.id, bookingRoomId: claimOfRoom.get(roomOfSlot.get(g.slotNo)!)!, checkIn: created.checkIn, checkOut: created.checkOut })))
    if (hold.priceLines.length > 0) await this.#org.insertMany(bookingPriceLine, hold.priceLines.map(line => ({ ...line, bookingId: created.id })))
    await this.#org.insert(bookingChange, {
      bookingId: created.id,
      kind: 'CREATED',
      afterData: { status: created.status, rooms: hold.rooms.length, totalCount: created.totalCount, infantCount: created.infantCount },
      actorKind: hold.actor.kind,
      actorId: hold.actor.id,
    })
    return created
  }

  /** v7 §10 step 3: pending bookings with a claim on these (already locked) rooms whose hold lapsed become EXPIRED. Returns their ids. */
  async expireLapsedHolds(roomIds: readonly string[], now: Date): Promise<string[]> {
    if (roomIds.length === 0) return []
    const ids = sql`array[${sql.join([...new Set(roomIds)].map(id => sql`${id}::uuid`), sql`, `)}]`
    return expireLapsed(this.db, this.scope.organizationId, now, sql`and b.hotel_id = ${this.scope.hotelId}::uuid and exists (
      select 1 from public.booking_room br
      where br.organization_id = b.organization_id and br.hotel_id = b.hotel_id and br.booking_id = b.id and br.room_id = any(${ids}))`)
  }
}

/** The organization-wide hold sweep (v7 §10: every minute, the backup to the in-transaction expiry). */
export class BookingExpiryRepository {
  constructor(private readonly db: DbOrTx, private readonly scope: OrganizationScope) {}

  /** Every pending booking of the organization whose hold lapsed becomes EXPIRED, in batches. Returns their ids. */
  async expireLapsed(now: Date): Promise<string[]> {
    const expired: string[] = []
    for (;;) {
      const batch = await expireLapsed(this.db, this.scope.organizationId, now, sql``, SWEEP_BATCH)
      expired.push(...batch)
      if (batch.length < SWEEP_BATCH) return expired
    }
  }
}
