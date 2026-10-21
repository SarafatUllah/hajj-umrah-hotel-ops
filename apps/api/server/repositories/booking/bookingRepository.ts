import { and, asc, count, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, like, lte, or, type SQL, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { booking, bookingChange, bookingGuest, bookingPriceLine, bookingRoom, floor, guestStay, room } from '@hajj/db/schema'
import { type AgeGroup, type BookingChangeKind, type BookingRoomStatus, type BookingStatus, type Gender, type Occupancy, PENDING_BOOKING_STATUSES, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import type { PriceSource } from '@hajj/contracts/constants/pricing'
import type { BookingRoomLine } from '@hajj/contracts/types/booking'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { IsoDate } from '@hajj/contracts/utils/dates'
import type { HotelScope, OrganizationScope } from '../../security/scope'
import { HotelQuery, OrgQuery } from '../base/scopedQuery'
import { escapeLikePattern } from '../base/likePattern'

export type BookingRow = typeof booking.$inferSelect
export type BookingPriceLineRow = typeof bookingPriceLine.$inferSelect
export type BookingListRow = BookingRow & { totalHalalas: number }

/** A booking due for the details reminder: how many of its slots still lack details, of how many. */
export interface DetailsReminderRow { booking: BookingRow, pending: number, slots: number }

export interface BookingListFilter {
  /** The effective status (a pending booking whose hold lapsed counts as EXPIRED, judged at `now`). */
  status?: BookingStatus
  now: Date
  hotelId?: string
  agencyId?: string
  customerId?: string
  /** Staff without access to every hotel see only these hotels' bookings. */
  hotelIds?: readonly string[]
  /** The start of the booking number. */
  q?: string
  page: number
  pageSize: number
}

export type { BookingRoomLine }

export interface BookingDetails {
  rooms: BookingRoomLine[]
  /** Pilgrim slots per status (removed slots included, so callers decide what to count). */
  guestStatuses: Record<string, number>
  priceLines: BookingPriceLineRow[]
}

/** A `booking_change` row (v7 §12): ids and PII-free facts only. */
export interface BookingChangeEntry {
  bookingId: string
  kind: BookingChangeKind
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  actor: { kind: ActorKind, id: string | null }
  reason?: string | null
}
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

/** Pilgrims joining a booking (v7 §12): the rooms they sleep in and their slots (slot numbers after the booking's last). */
export interface GuestAddition {
  booking: BookingRow
  rooms: NewHold['rooms']
  guests: NewHold['guests']
}

/** A booking moving whole to new dates (v7 §12 date change): its new rooms, where each live slot sleeps, its new price. */
export interface Rebooking {
  booking: BookingRow
  checkIn: IsoDate
  checkOut: IsoDate
  quoteId: string | null
  priceSource: PriceSource
  rooms: NewHold['rooms']
  /** Every live slot (removed ones sleep nowhere) and the room it sleeps in on the new dates. */
  seats: ReadonlyArray<{ guestId: string, roomId: string, isExtraBed: boolean }>
  priceLines: readonly NewPriceLine[]
  at: Date
}

/** The later of the application's clock and the database's: the moment a hold is judged lapsed (or still valid) at. */
const judgedAt = (now: Date) => sql`greatest(${now.toISOString()}::timestamptz, clock_timestamp())`

const pendingStatus = inArray(booking.status, [...PENDING_BOOKING_STATUSES])

/** The effective status as a condition: a pending booking whose hold lapsed is EXPIRED, not HELD or REQUESTED. */
function effectiveStatusIs(status: BookingStatus, now: Date): SQL {
  const lapsed = sql`${booking.holdExpiresAt} <= ${judgedAt(now)}`
  if (status === 'EXPIRED') return or(eq(booking.status, 'EXPIRED'), and(pendingStatus, lapsed))!
  if ((PENDING_BOOKING_STATUSES as readonly string[]).includes(status)) return and(eq(booking.status, status), sql`not (${lapsed})`)!
  return eq(booking.status, status)
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
  const at = judgedAt(now)
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

  /**
   * v7 §12 add pilgrims: their slots join the booking with their stays for its dates — in its own claim when the
   * booking already has the room (extra beds go only in new rooms), otherwise in a new claim; the database checks the
   * rest (owner and occupancy per room-night, stays within claims at commit).
   */
  async appendGuests(addition: GuestAddition): Promise<void> {
    const b = addition.booking
    const current = await this.#q.select(bookingRoom, and(eq(bookingRoom.bookingId, b.id), inArray(bookingRoom.status, [...SEAT_HOLDING_STATUSES]))!)
    const claimOfRoom = new Map(current.map(c => [c.roomId, c.id]))
    for (const r of addition.rooms) {
      if (claimOfRoom.has(r.roomId)) continue
      const [claim] = await this.#q.insert(bookingRoom, {
        bookingId: b.id,
        roomId: r.roomId,
        ownerAgencyId: r.ownedByAgency ? b.agencyId : null,
        ownerBookingId: r.ownedByAgency ? null : b.id,
        occupancy: r.occupancy,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        status: b.status,
        extraBeds: r.extraBeds,
      }).returning({ id: bookingRoom.id })
      claimOfRoom.set(r.roomId, claim!.id)
    }
    if (addition.guests.length === 0) return
    const guests = await this.#org.insertMany(bookingGuest, addition.guests.map(g => ({ bookingId: b.id, slotNo: g.slotNo, gender: g.gender, ageGroup: g.ageGroup, isExtraBed: g.isExtraBed })))
      .returning({ id: bookingGuest.id, slotNo: bookingGuest.slotNo })
    const roomOfSlot = new Map(addition.guests.map(g => [g.slotNo, g.roomId]))
    await this.#org.insertMany(guestStay, guests.map(g => ({ bookingId: b.id, bookingGuestId: g.id, bookingRoomId: claimOfRoom.get(roomOfSlot.get(g.slotNo)!)!, checkIn: b.checkIn, checkOut: b.checkOut })))
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

/**
 * The organization-wide booking records: reading bookings across hotels (an agency's own list, staff lists), the
 * confirmation, the change log and the minute hold sweep (v7 §10).
 */
export class BookingRecordRepository {
  readonly #q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.#q = new OrgQuery(db, scope)
  }

  /** `forUpdate` (inside a transaction) row-locks the booking: changes to its slots serialize behind it. */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<BookingRow | null> {
    const [row] = await this.#q.select(booking, eq(booking.id, id), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  /** Newest first, each with the total of its frozen price lines. */
  async list(filter: BookingListFilter): Promise<{ rows: BookingListRow[], total: number }> {
    const where = this.#q.cond(
      booking,
      filter.status ? effectiveStatusIs(filter.status, filter.now) : undefined,
      filter.hotelId ? eq(booking.hotelId, filter.hotelId) : undefined,
      filter.agencyId ? eq(booking.agencyId, filter.agencyId) : undefined,
      filter.customerId ? eq(booking.customerId, filter.customerId) : undefined,
      filter.hotelIds ? (filter.hotelIds.length > 0 ? inArray(booking.hotelId, [...filter.hotelIds]) : sql`false`) : undefined,
      filter.q ? like(booking.bookingNo, `${escapeLikePattern(filter.q)}%`) : undefined,
    )
    // Outer columns written out in full: inside a subquery Drizzle would render them unqualified (the inner table's).
    // A sum of halalas can pass 2^31 for a large long group: bigint, read back as a number.
    const totalHalalas = sql<number>`(select coalesce(sum(l.amount_halalas), 0)::bigint from public.booking_price_line l where l.organization_id = "booking"."organization_id" and l.booking_id = "booking"."id")`.mapWith(Number)
    const [rows, [totalRow]] = await Promise.all([
      this.db.select({ ...getTableColumns(booking), totalHalalas }).from(booking).where(where).orderBy(desc(booking.createdAt), desc(booking.id)).limit(filter.pageSize).offset((filter.page - 1) * filter.pageSize),
      this.db.select({ value: count() }).from(booking).where(where),
    ])
    return { rows, total: Number(totalRow?.value ?? 0) }
  }

  /** The booking's rooms (with number and floor), its slots per status and its frozen price lines. */
  async details(bookingId: string): Promise<BookingDetails> {
    const [rooms, guests, priceLines] = await Promise.all([
      this.db
        .select({ roomId: bookingRoom.roomId, roomNumber: room.roomNumber, floorLevel: floor.level, roomTypeId: room.roomTypeId, occupancy: bookingRoom.occupancy, extraBeds: bookingRoom.extraBeds, status: bookingRoom.status, checkIn: bookingRoom.checkIn, checkOut: bookingRoom.checkOut })
        .from(bookingRoom)
        .innerJoin(room, and(eq(room.organizationId, bookingRoom.organizationId), eq(room.hotelId, bookingRoom.hotelId), eq(room.id, bookingRoom.roomId)))
        .innerJoin(floor, and(eq(floor.organizationId, room.organizationId), eq(floor.hotelId, room.hotelId), eq(floor.id, room.floorId)))
        .where(this.#q.cond(bookingRoom, eq(bookingRoom.bookingId, bookingId)))
        .orderBy(sql`length(${room.roomNumber})`, asc(room.roomNumber), asc(bookingRoom.checkIn)),
      this.db.select({ status: bookingGuest.status, n: count() }).from(bookingGuest).where(this.#q.cond(bookingGuest, eq(bookingGuest.bookingId, bookingId))).groupBy(bookingGuest.status),
      this.#q.select(bookingPriceLine, eq(bookingPriceLine.bookingId, bookingId), { orderBy: [asc(bookingPriceLine.night), asc(bookingPriceLine.kind), asc(bookingPriceLine.roomTypeId)] }),
    ])
    return {
      rooms: rooms.map(r => ({ ...r, occupancy: r.occupancy as Occupancy, status: r.status as BookingRoomStatus })),
      guestStatuses: Object.fromEntries(guests.map(g => [g.status, Number(g.n)])),
      priceLines,
    }
  }

  /**
   * v7 §10: confirms a pending booking whose hold has not lapsed — judged by the same rule as the expiry, so a
   * hold the seat count already treats as free can never come back. Only this row is locked (no room locks).
   * Clears the expiry, stamps the receipt token. null = not pending, or lapsed (the caller reads why).
   */
  async confirm(id: string, values: { now: Date, confirmedBy: string | null, receiptToken: string }): Promise<BookingRow | null> {
    const [row] = await this.#q.update(
      booking,
      { status: 'CONFIRMED', confirmedAt: values.now, confirmedBy: values.confirmedBy, receiptToken: values.receiptToken, holdExpiresAt: null, updatedAt: values.now },
      eq(booking.id, id),
      pendingStatus,
      sql`${booking.holdExpiresAt} > ${judgedAt(values.now)}`,
    ).returning()
    return row ?? null
  }

  /**
   * v7 §10 (individual bookers: at most a few open requests at a time): takes the customer's request lock (a
   * transaction-scoped advisory lock on the organization and customer, before any room lock) and counts the
   * customer's open requests — pending bookings whose hold has not lapsed. Inside a transaction only.
   */
  async lockOpenRequests(customerId: string, now: Date): Promise<number> {
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`requests:${this.#q.scope.organizationId}:${customerId}`}, 0))`)
    const [row] = await this.db.select({ n: count() }).from(booking)
      .where(this.#q.cond(booking, eq(booking.customerId, customerId), pendingStatus, sql`${booking.holdExpiresAt} > ${judgedAt(now)}`))
    return Number(row?.n ?? 0)
  }

  async recordChange(entry: BookingChangeEntry): Promise<void> {
    await this.#q.insert(bookingChange, { bookingId: entry.bookingId, kind: entry.kind, beforeData: entry.before, afterData: entry.after, actorKind: entry.actor.kind, actorId: entry.actor.id, reason: entry.reason ?? null })
  }

  /** The booking a receipt's QR code names (the token admits no one by itself: the caller authorizes). */
  async findByReceiptToken(token: string): Promise<BookingRow | null> {
    const [row] = await this.#q.select(booking, eq(booking.receiptToken, token), { limit: 1 })
    return row ?? null
  }

  /** The stay status of a booking the caller holds locked (IN_HOUSE from the first arrival, COMPLETED at the end). */
  async setStatus(id: string, status: BookingStatus, at: Date): Promise<BookingRow | null> {
    const [row] = await this.#q.update(booking, { status, updatedAt: at }, eq(booking.id, id)).returning()
    return row ?? null
  }

  /**
   * Confirmed bookings checking in between `from` and `to` (inclusive) whose booker was not reminded yet and that
   * still have slots without details (v7 §15), the soonest first; `after` continues past a page (keyset).
   */
  async dueForDetailsReminder(from: IsoDate, to: IsoDate, limit: number, after?: { checkIn: IsoDate, id: string }): Promise<DetailsReminderRow[]> {
    // Outer columns written out in full (inside a subquery Drizzle would render them unqualified).
    const slotsOf = (status: SQL) => sql`(select count(*) from public.booking_guest g where g.organization_id = "booking"."organization_id" and g.booking_id = "booking"."id" and ${status})`
    const pending = sql<number>`${slotsOf(sql`g.status = 'PENDING_DETAILS'`)}`.mapWith(Number)
    const slots = sql<number>`${slotsOf(sql`g.status <> 'REMOVED'`)}`.mapWith(Number)
    return this.db.select({ booking, pending, slots }).from(booking)
      .where(this.#q.cond(
        booking,
        eq(booking.status, 'CONFIRMED'),
        gte(booking.checkIn, from),
        lte(booking.checkIn, to),
        isNull(booking.detailsRemindedAt),
        sql`${slotsOf(sql`g.status = 'PENDING_DETAILS'`)} > 0`,
        after ? sql`(${booking.checkIn}, ${booking.id}) > (${after.checkIn}::date, ${after.id}::uuid)` : undefined,
      ))
      .orderBy(asc(booking.checkIn), asc(booking.id))
      .limit(limit)
  }

  /** The booker was reminded; false when someone else marked it first. */
  async markDetailsReminded(id: string, at: Date): Promise<boolean> {
    const rows = await this.#q.update(booking, { detailsRemindedAt: at }, eq(booking.id, id), isNull(booking.detailsRemindedAt)).returning({ id: booking.id })
    return rows.length > 0
  }

  /**
   * Ticket 4: the bookings that checked out on or before `cutoff` and still hold personal data — an unerased copy, a
   * slot linked to a staff master, a passport reading or an image not due by `today`, free text — oldest first;
   * `after` continues past a batch (keyset).
   */
  async dueForErasure(cutoff: IsoDate, today: IsoDate, limit: number, after?: { checkOut: IsoDate, id: string }): Promise<Array<{ id: string, checkOut: IsoDate }>> {
    const holdsPersonalData = sql`(
      ${booking.notes} is not null or ${booking.cancelReason} is not null
      or exists (select 1 from public.booking_guest_detail d where d.organization_id = "booking"."organization_id" and d.booking_id = "booking"."id" and d.erased_at is null)
      or exists (select 1 from public.booking_guest g where g.organization_id = "booking"."organization_id" and g.booking_id = "booking"."id" and g.pilgrim_id is not null)
      or exists (select 1 from public.passport_scan s where s.organization_id = "booking"."organization_id" and s.booking_id = "booking"."id"
        and (s.extracted_encrypted is not null or s.delete_after is null or s.delete_after > ${today}::date))
      or exists (select 1 from public.hotel_task t where t.organization_id = "booking"."organization_id" and t.booking_id = "booking"."id" and t.notes is not null))`
    // A booking that will not happen counts from the day it ended (cancelled, or lapsed), when that came before its stay's end.
    const ended = sql`coalesce(${booking.cancelledAt}, ${booking.holdExpiresAt}, ${booking.updatedAt})::date`
    const retentionOver = or(lte(booking.checkOut, cutoff), and(inArray(booking.status, ['CANCELLED', 'EXPIRED']), sql`${ended} <= ${cutoff}::date`))
    return this.db.select({ id: booking.id, checkOut: booking.checkOut }).from(booking)
      .where(this.#q.cond(
        booking,
        retentionOver,
        holdsPersonalData,
        after ? sql`(${booking.checkOut}, ${booking.id}) > (${after.checkOut}::date, ${after.id}::uuid)` : undefined,
      ))
      .orderBy(asc(booking.checkOut), asc(booking.id))
      .limit(limit)
  }

  /** Ticket 4: the free text of these bookings (notes, cancel reason) may name people: cleared. Takes their row locks first. */
  async clearFreeText(bookingIds: readonly string[]): Promise<void> {
    if (bookingIds.length === 0) return
    await this.#q.update(booking, { notes: null, cancelReason: null }, inArray(booking.id, [...bookingIds]))
  }

  /** v7 §12: CANCELLED (its room claims follow by trigger, so the seats are free). The caller holds the row lock. */
  async cancel(id: string, values: { at: Date, by: string | null, reason: string | null }): Promise<BookingRow | null> {
    const [row] = await this.#q.update(booking, { status: 'CANCELLED', cancelledAt: values.at, cancelledBy: values.by, cancelReason: values.reason, updatedAt: values.at }, eq(booking.id, id)).returning()
    return row ?? null
  }

  /**
   * v7 §12 early departure / no-show: the booking's claims `claimIds` no longer hold the nights from `day` on that no
   * stay of theirs uses — a claim nobody sleeps in after `day` ends that day (one that had not begun is RELEASED), so
   * the room is free for others. The claims' stays were ended first (containment).
   */
  async trimClaims(bookingId: string, claimIds: readonly string[], day: IsoDate, at: Date): Promise<void> {
    for (const claimId of claimIds) {
      const [claim] = await this.#q.select(bookingRoom, and(eq(bookingRoom.bookingId, bookingId), eq(bookingRoom.id, claimId))!, { limit: 1 })
      if (!claim || claim.checkOut <= day) continue
      const [last] = await this.db.select({ end: sql<string | null>`max(${guestStay.checkOut})::text` }).from(guestStay).where(this.#q.cond(guestStay, eq(guestStay.bookingRoomId, claimId)))
      const end = last?.end ?? null
      if (end !== null && end >= claim.checkOut) continue
      if (claim.checkIn >= day && end === null) await this.#q.update(bookingRoom, { status: 'RELEASED', updatedAt: at }, eq(bookingRoom.id, claimId))
      else await this.#q.update(bookingRoom, { checkOut: end !== null && end > day ? end : day, updatedAt: at }, eq(bookingRoom.id, claimId))
    }
  }

  /**
   * v7 §12 add pilgrims: their price lines join the booking's — a night already priced for that kind and room type
   * keeps its frozen unit price (only the quantity grows), any other is added as priced now. Returns the halalas added.
   */
  async mergePriceLines(bookingId: string, lines: readonly NewPriceLine[]): Promise<number> {
    if (lines.length === 0) return 0
    const key = (l: { night: string, kind: string, roomTypeId?: string | null }) => `${l.night}|${l.kind}|${l.roomTypeId ?? ''}`
    const existing = new Map((await this.#q.select(bookingPriceLine, eq(bookingPriceLine.bookingId, bookingId))).map(l => [key(l), l]))
    let added = 0
    for (const line of lines) {
      const frozen = existing.get(key(line))
      if (!frozen) {
        await this.#q.insert(bookingPriceLine, { ...line, bookingId })
        added += line.amountHalalas
        continue
      }
      const amount = line.quantity * frozen.unitAmountHalalas
      await this.#q.update(bookingPriceLine, { quantity: frozen.quantity + line.quantity, amountHalalas: frozen.amountHalalas + amount }, eq(bookingPriceLine.id, frozen.id))
      added += amount
    }
    return added
  }

  /**
   * v7 §12 room move: the booking's claim on `roomId` covering `from` to its check-out — its own live claim there of the
   * same side that reaches `from` (the latest, stretched when it covers less: one that merely ends on `from` was not
   * among the nights checked, so its side must match), else a new one with the booking's owner (an agency's for a
   * GROUP). The caller checked the room for those nights.
   */
  async claimForMove(row: BookingRow, roomId: string, occupancy: Occupancy, from: IsoDate, ownedByAgency: boolean, at: Date): Promise<string> {
    const [own] = await this.#q.select(
      bookingRoom,
      and(eq(bookingRoom.bookingId, row.id), eq(bookingRoom.roomId, roomId), eq(bookingRoom.occupancy, occupancy), gte(bookingRoom.checkOut, from), inArray(bookingRoom.status, [...SEAT_HOLDING_STATUSES]))!,
      { orderBy: [desc(bookingRoom.checkIn)], limit: 1 },
    )
    if (own) {
      const checkIn = own.checkIn < from ? own.checkIn : from
      const checkOut = own.checkOut > row.checkOut ? own.checkOut : row.checkOut
      if (checkIn !== own.checkIn || checkOut !== own.checkOut) await this.#q.update(bookingRoom, { checkIn, checkOut, updatedAt: at }, eq(bookingRoom.id, own.id))
      return own.id
    }
    const [claim] = await this.#q.insert(bookingRoom, {
      hotelId: row.hotelId,
      bookingId: row.id,
      roomId,
      ownerAgencyId: ownedByAgency ? row.agencyId : null,
      ownerBookingId: ownedByAgency ? null : row.id,
      occupancy,
      checkIn: from,
      checkOut: row.checkOut,
      status: row.status,
      extraBeds: 0,
    }).returning({ id: bookingRoom.id })
    return claim!.id
  }

  /**
   * v7 §12 date change (the caller holds the booking's lock and checked the new rooms): the booking moves whole — its
   * dates, quote and price source; its stays, claims (released ones too) and price lines are replaced by the new
   * ones; each slot keeps its details, its extra-bed flag follows its new seat; the details reminder may come again.
   * Containment is checked at COMMIT. null = no such booking (none of this organization's).
   */
  async rebook(change: Rebooking): Promise<BookingRow | null> {
    const [row] = await this.#q.update(
      booking,
      { checkIn: change.checkIn, checkOut: change.checkOut, quoteId: change.quoteId, priceSource: change.priceSource, detailsRemindedAt: null, updatedAt: change.at },
      eq(booking.id, change.booking.id),
    ).returning()
    if (!row) return null
    await this.#q.delete(guestStay, eq(guestStay.bookingId, row.id))
    await this.#q.delete(bookingRoom, eq(bookingRoom.bookingId, row.id))
    await this.#q.delete(bookingPriceLine, eq(bookingPriceLine.bookingId, row.id))
    const claims = change.rooms.length === 0 ? [] : await this.#q.insertMany(bookingRoom, change.rooms.map(r => ({
      hotelId: row.hotelId,
      bookingId: row.id,
      roomId: r.roomId,
      ownerAgencyId: r.ownedByAgency ? row.agencyId : null,
      ownerBookingId: r.ownedByAgency ? null : row.id,
      occupancy: r.occupancy,
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      status: row.status,
      extraBeds: r.extraBeds,
    }))).returning({ id: bookingRoom.id, roomId: bookingRoom.roomId })
    const claimOfRoom = new Map(claims.map(c => [c.roomId, c.id]))
    for (const isExtraBed of [true, false]) {
      const ids = change.seats.filter(s => s.isExtraBed === isExtraBed).map(s => s.guestId)
      if (ids.length > 0) await this.#q.update(bookingGuest, { isExtraBed }, eq(bookingGuest.bookingId, row.id), inArray(bookingGuest.id, ids), eq(bookingGuest.isExtraBed, !isExtraBed))
    }
    if (change.seats.length > 0) {
      await this.#q.insertMany(guestStay, change.seats.map(s => ({ bookingId: row.id, bookingGuestId: s.guestId, bookingRoomId: claimOfRoom.get(s.roomId)!, checkIn: row.checkIn, checkOut: row.checkOut })))
    }
    if (change.priceLines.length > 0) await this.#q.insertMany(bookingPriceLine, change.priceLines.map(line => ({ ...line, bookingId: row.id })))
    return row
  }

  /** Step 15b account closure: the customer's bookings that still hold seats (pending, confirmed or in the house). */
  async liveForCustomer(customerId: string): Promise<BookingRow[]> {
    return this.#q.select(booking, and(eq(booking.customerId, customerId), inArray(booking.status, [...SEAT_HOLDING_STATUSES]))!, { orderBy: [asc(booking.checkIn)] })
  }

  /** v7 §12: the booking's head count after pilgrims joined or left (the caller holds the row lock). */
  async setCounts(id: string, counts: { maleCount: number, femaleCount: number, childCount: number, infantCount: number, totalCount: number }, at: Date): Promise<BookingRow | null> {
    const [row] = await this.#q.update(booking, { ...counts, updatedAt: at }, eq(booking.id, id)).returning()
    return row ?? null
  }

  /**
   * v7 §12: a room the booking itself owns (a family's or an individual's — never an agency's, whose free seats stay
   * the agency's) that nobody still on the booking sleeps in is let go (RELEASED). Returns how many.
   */
  async releaseEmptyClaims(bookingId: string, at: Date): Promise<number> {
    // Outer columns written out in full (inside a subquery Drizzle would render them unqualified).
    const rows = await this.#q.update(
      bookingRoom,
      { status: 'RELEASED', updatedAt: at },
      eq(bookingRoom.bookingId, bookingId),
      isNotNull(bookingRoom.ownerBookingId),
      inArray(bookingRoom.status, [...SEAT_HOLDING_STATUSES]),
      sql`not exists (select 1 from public.guest_stay gs join public.booking_guest g on g.organization_id = gs.organization_id and g.id = gs.booking_guest_id
        where gs.organization_id = "booking_room"."organization_id" and gs.booking_room_id = "booking_room"."id" and g.status <> 'REMOVED')`,
    ).returning({ id: bookingRoom.id })
    return rows.length
  }

  /** Every pending booking of the organization whose hold lapsed becomes EXPIRED, in batches. Returns their ids. */
  async expireLapsed(now: Date): Promise<string[]> {
    const expired: string[] = []
    for (;;) {
      const batch = await expireLapsed(this.db, this.#q.scope.organizationId, now, sql``, SWEEP_BATCH)
      expired.push(...batch)
      if (batch.length < SWEEP_BATCH) return expired
    }
  }
}
