import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import type { DbOrTx } from '@hajj/db/client'
import { booking, bookingGuest, bookingGuestDetail, bookingRoom, guestStay, piiAccessLog, pilgrim, room } from '@hajj/db/schema'
import { type GuestStatus, type Occupancy, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import type { IsoDate } from '@hajj/contracts/utils/dates'
import type { OrganizationScope } from '../../security/scope'
import { OrgQuery } from '../base/scopedQuery'

export type BookingGuestRow = typeof bookingGuest.$inferSelect
export type BookingGuestDetailRow = typeof bookingGuestDetail.$inferSelect
export type PilgrimRow = typeof pilgrim.$inferSelect
type NewGuestDetail = Omit<typeof bookingGuestDetail.$inferInsert, 'organizationId' | 'id' | 'createdAt' | 'updatedAt'>
type NewPilgrim = Omit<typeof pilgrim.$inferInsert, 'organizationId' | 'id' | 'createdAt' | 'updatedAt'>
type NewPiiAccess = Omit<typeof piiAccessLog.$inferInsert, 'organizationId' | 'id' | 'accessedAt'>

/** A slot with the booker's copy of its details and the room it sleeps in (its latest stay). */
export interface GuestSlotRow { guest: BookingGuestRow, detail: BookingGuestDetailRow | null, roomNumber: string | null, occupancy: string | null }

export interface SlotPatch {
  gender?: string | null
  ageGroup?: string
  status?: string
  pilgrimId?: string | null
  checkedInAt?: Date
  checkedInBy?: string
  checkedOutAt?: Date
  checkedOutBy?: string
}

/** Another live booking holding the same passport on overlapping nights (v7 §13: a staff warning). */
export interface PassportOverlap { passportLookup: string, bookingId: string, bookingNo: string }

/**
 * The booking module's pilgrim data of one organization (v7 §7, §16): the slots of a booking with the booker's own
 * copy of each pilgrim's details. Callers decide who may see what (agencies only their own bookings).
 */
export class GuestRepository {
  readonly #q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.#q = new OrgQuery(db, scope)
  }

  /** Every slot of the booking, by slot number. */
  async listForBooking(bookingId: string): Promise<GuestSlotRow[]> {
    const [slots, rooms] = await Promise.all([
      this.db.select({ guest: bookingGuest, detail: bookingGuestDetail }).from(bookingGuest)
        .leftJoin(bookingGuestDetail, and(eq(bookingGuestDetail.organizationId, bookingGuest.organizationId), eq(bookingGuestDetail.bookingGuestId, bookingGuest.id)))
        .where(this.#q.cond(bookingGuest, eq(bookingGuest.bookingId, bookingId)))
        .orderBy(asc(bookingGuest.slotNo)),
      this.#roomsOfGuests(bookingId),
    ])
    return slots.map(s => ({ ...s, roomNumber: rooms.get(s.guest.id)?.roomNumber ?? null, occupancy: rooms.get(s.guest.id)?.occupancy ?? null }))
  }

  /**
   * v7 §12 early departure / no-show: the slot sleeps nowhere from `day` on — its stays end that day (one that had
   * not begun is removed). Returns the room claims those stays were in.
   */
  async endStaysFrom(bookingId: string, guestId: string, day: IsoDate): Promise<string[]> {
    const stays = await this.#q.select(guestStay, and(eq(guestStay.bookingId, bookingId), eq(guestStay.bookingGuestId, guestId), gt(guestStay.checkOut, day))!)
    for (const stay of stays) {
      if (stay.checkIn >= day) await this.#q.delete(guestStay, eq(guestStay.id, stay.id))
      else await this.#q.update(guestStay, { checkOut: day }, eq(guestStay.id, stay.id))
    }
    return [...new Set(stays.map(s => s.bookingRoomId))]
  }

  /** The first night the slot sleeps in the hotel (its earliest stay), or null without a stay. */
  async firstNight(bookingId: string, guestId: string): Promise<IsoDate | null> {
    const [row] = await this.db.select({ first: sql<string | null>`min(${guestStay.checkIn})::text` }).from(guestStay)
      .where(this.#q.cond(guestStay, eq(guestStay.bookingId, bookingId), eq(guestStay.bookingGuestId, guestId)))
    return row?.first ?? null
  }

  /** The stays of these slots that still have nights from `day` on, with the room and side they sleep in. */
  async staysFrom(bookingId: string, guestIds: readonly string[], day: IsoDate): Promise<Array<{ stayId: string, guestId: string, claimId: string, roomId: string, occupancy: Occupancy }>> {
    if (guestIds.length === 0) return []
    const rows = await this.db.select({ stayId: guestStay.id, guestId: guestStay.bookingGuestId, claimId: guestStay.bookingRoomId, roomId: bookingRoom.roomId, occupancy: bookingRoom.occupancy })
      .from(guestStay)
      .innerJoin(bookingRoom, and(eq(bookingRoom.organizationId, guestStay.organizationId), eq(bookingRoom.id, guestStay.bookingRoomId)))
      .where(this.#q.cond(guestStay, eq(guestStay.bookingId, bookingId), inArray(guestStay.bookingGuestId, [...guestIds]), gt(guestStay.checkOut, day)))
    return rows.map(r => ({ ...r, occupancy: r.occupancy as Occupancy }))
  }

  /**
   * v7 §12 room move: from `day` on these slots sleep in the claim `toClaimId` — a stay that began before is split
   * there (its earlier nights stay where they were), a later one moves whole. Returns the claims they left.
   */
  async moveStaysFrom(bookingId: string, guestIds: readonly string[], day: IsoDate, toClaimId: string): Promise<string[]> {
    if (guestIds.length === 0) return []
    const stays = await this.#q.select(guestStay, and(eq(guestStay.bookingId, bookingId), inArray(guestStay.bookingGuestId, [...guestIds]), gt(guestStay.checkOut, day))!)
    for (const stay of stays) {
      if (stay.checkIn >= day) {
        await this.#q.update(guestStay, { bookingRoomId: toClaimId }, eq(guestStay.id, stay.id))
        continue
      }
      await this.#q.update(guestStay, { checkOut: day }, eq(guestStay.id, stay.id))
      await this.#q.insert(guestStay, { bookingId, bookingGuestId: stay.bookingGuestId, bookingRoomId: toClaimId, checkIn: day, checkOut: stay.checkOut })
    }
    return [...new Set(stays.map(s => s.bookingRoomId))]
  }

  /** The status of every slot of the booking. */
  async statuses(bookingId: string): Promise<GuestStatus[]> {
    const rows = await this.db.select({ status: bookingGuest.status }).from(bookingGuest).where(this.#q.cond(bookingGuest, eq(bookingGuest.bookingId, bookingId)))
    return rows.map(r => r.status as GuestStatus)
  }

  /** One slot of the booking (`forUpdate` row-locks the slot inside a transaction), or null. */
  async findSlot(bookingId: string, guestId: string, options: { forUpdate?: boolean } = {}): Promise<GuestSlotRow | null> {
    const [slot] = await this.#q.select(bookingGuest, and(eq(bookingGuest.bookingId, bookingId), eq(bookingGuest.id, guestId)), { limit: 1, forUpdate: options.forUpdate })
    if (!slot) return null
    const [detail] = await this.#q.select(bookingGuestDetail, eq(bookingGuestDetail.bookingGuestId, slot.id), { limit: 1 })
    const place = (await this.#roomsOfGuests(bookingId, slot.id)).get(slot.id)
    return { guest: slot, detail: detail ?? null, roomNumber: place?.roomNumber ?? null, occupancy: place?.occupancy ?? null }
  }

  /** The booker's copy for a slot: created on the first save, replaced afterwards (one copy per slot). */
  async saveDetail(values: NewGuestDetail): Promise<BookingGuestDetailRow> {
    const { bookingId: _bookingId, bookingGuestId: _guestId, ...changes } = values
    const [row] = await this.#q.insert(bookingGuestDetail, values)
      // Re-entered after the retention sweep erased it: the copy holds personal data again.
      .onConflictDoUpdate({ target: [bookingGuestDetail.organizationId, bookingGuestDetail.bookingGuestId], set: { ...changes, erasedAt: null, updatedAt: new Date() } })
      .returning()
    return row!
  }

  /** Ticket 4: the slots of these bookings let go of the staff master (before their copies are erased: a save's lock order). */
  async releaseMasters(bookingIds: readonly string[]): Promise<number> {
    if (bookingIds.length === 0) return 0
    const rows = await this.#q.update(bookingGuest, { pilgrimId: null }, isNotNull(bookingGuest.pilgrimId), inArray(bookingGuest.bookingId, [...bookingIds])).returning({ id: bookingGuest.id })
    return rows.length
  }

  /**
   * Ticket 4: erases in place every booker's copy of these bookings not erased yet — name, gender, nationality,
   * dates, passport and extras are cleared; the row and its slot stay. Returns how many copies were erased.
   */
  async eraseCopies(bookingIds: readonly string[], at: Date): Promise<number> {
    if (bookingIds.length === 0) return 0
    const rows = await this.#q.update(
      bookingGuestDetail,
      { fullName: '', gender: null, nationality: null, dateOfBirth: null, passportNoEncrypted: null, passportLookup: null, passportExpiry: null, detailsEncrypted: null, erasedAt: at, updatedAt: at },
      isNull(bookingGuestDetail.erasedAt),
      inArray(bookingGuestDetail.bookingId, [...bookingIds]),
    ).returning({ id: bookingGuestDetail.id })
    return rows.length
  }

  async updateSlot(bookingId: string, guestId: string, patch: SlotPatch): Promise<BookingGuestRow | null> {
    const [row] = await this.#q.update(bookingGuest, { ...patch, updatedAt: new Date() }, eq(bookingGuest.bookingId, bookingId), eq(bookingGuest.id, guestId)).returning()
    return row ?? null
  }

  /**
   * Live bookings (other than `excludeBookingId`) whose slots carry one of these passports on nights overlapping
   * `[checkIn, checkOut)` — only in `hotelIds` when given (a viewer learns nothing about hotels it cannot see).
   */
  async passportOverlaps(lookups: readonly string[], stay: { checkIn: IsoDate, checkOut: IsoDate }, excludeBookingId: string, hotelIds?: readonly string[]): Promise<PassportOverlap[]> {
    if (hotelIds?.length === 0) return []
    if (lookups.length === 0) return []
    return this.db
      .select({ passportLookup: bookingGuestDetail.passportLookup, bookingId: booking.id, bookingNo: booking.bookingNo })
      .from(bookingGuestDetail)
      .innerJoin(booking, and(eq(booking.organizationId, bookingGuestDetail.organizationId), eq(booking.id, bookingGuestDetail.bookingId)))
      .innerJoin(bookingGuest, and(eq(bookingGuest.organizationId, bookingGuestDetail.organizationId), eq(bookingGuest.id, bookingGuestDetail.bookingGuestId)))
      .where(this.#q.cond(
        bookingGuestDetail,
        inArray(bookingGuestDetail.passportLookup, [...new Set(lookups)]),
        ne(booking.id, excludeBookingId),
        inArray(booking.status, [...SEAT_HOLDING_STATUSES]),
        ne(bookingGuest.status, 'REMOVED'),
        lt(booking.checkIn, stay.checkOut),
        gt(booking.checkOut, stay.checkIn),
        hotelIds ? inArray(booking.hotelId, [...hotelIds]) : undefined,
      ))
      .orderBy(asc(booking.bookingNo)) as Promise<PassportOverlap[]>
  }

  /** Each slot's latest stay: the room number and the side it sleeps on. */
  async #roomsOfGuests(bookingId: string, guestId?: string): Promise<Map<string, { roomNumber: string, occupancy: string }>> {
    const rows = await this.db
      .select({ guestId: guestStay.bookingGuestId, roomNumber: room.roomNumber, occupancy: bookingRoom.occupancy })
      .from(guestStay)
      .innerJoin(bookingRoom, and(eq(bookingRoom.organizationId, guestStay.organizationId), eq(bookingRoom.id, guestStay.bookingRoomId)))
      .innerJoin(room, and(eq(room.organizationId, bookingRoom.organizationId), eq(room.hotelId, bookingRoom.hotelId), eq(room.id, bookingRoom.roomId)))
      .where(this.#q.cond(guestStay, eq(guestStay.bookingId, bookingId), guestId ? eq(guestStay.bookingGuestId, guestId) : undefined))
      .orderBy(asc(guestStay.bookingGuestId), desc(guestStay.checkIn))
    const latest = new Map<string, { roomNumber: string, occupancy: string }>()
    for (const r of rows) if (!latest.has(r.guestId)) latest.set(r.guestId, { roomNumber: r.roomNumber, occupancy: r.occupancy })
    return latest
  }
}

/** The staff-only master pilgrim records (v7 §16): one per passport per organization, never read by bookers. */
export class PilgrimRepository {
  readonly #q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.#q = new OrgQuery(db, scope)
  }

  /**
   * Ticket 4: deletes the masters no slot points at any more and nobody changed since `untouchedSince` (their
   * bookings' retention ended: the slots let go of them first). Returns how many.
   */
  async deleteUnreferenced(untouchedSince: Date): Promise<number> {
    // Outer columns written out in full (inside a subquery Drizzle would render them unqualified).
    const rows = await this.#q.delete(
      pilgrim,
      lt(pilgrim.updatedAt, untouchedSince),
      sql`not exists (select 1 from public.booking_guest g where g.organization_id = "pilgrim"."organization_id" and g.pilgrim_id = "pilgrim"."id")`,
    ).returning({ id: pilgrim.id })
    return rows.length
  }

  async findByLookup(passportLookup: string): Promise<PilgrimRow | null> {
    const [row] = await this.#q.select(pilgrim, eq(pilgrim.passportLookup, passportLookup), { limit: 1 })
    return row ?? null
  }

  /**
   * The master for a passport: created on first sight, never overwritten here (a typo at one desk must not rewrite
   * the record every booking of that pilgrim relies on). `created` false = it existed already, unchanged.
   */
  async createIfAbsent(values: NewPilgrim): Promise<{ row: PilgrimRow, created: boolean }> {
    const [inserted] = await this.#q.insert(pilgrim, values).onConflictDoNothing({ target: [pilgrim.organizationId, pilgrim.passportLookup] }).returning()
    if (inserted) return { row: inserted, created: true }
    return { row: (await this.findByLookup(values.passportLookup))!, created: false }
  }
}

/** v7 §13 (PDPL): who saw which personal data, when — ids and field names only, never values. Append-only. */
export class PiiAccessLogRepository {
  readonly #q: OrgQuery

  constructor(private readonly db: DbOrTx, scope: OrganizationScope) {
    this.#q = new OrgQuery(db, scope)
  }

  async record(entries: readonly NewPiiAccess[]): Promise<void> {
    if (entries.length > 0) await this.#q.insertMany(piiAccessLog, entries)
  }
}
