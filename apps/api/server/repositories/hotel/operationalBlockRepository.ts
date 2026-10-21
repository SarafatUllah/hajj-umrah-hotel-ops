import { and, asc, count, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../../../db/client'
import { appUser, room, roomOperationalBlock } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import type { BlockKind } from '../../../shared/constants/inventory'
import type { IsoDate, NightRange } from '../../../shared/utils/dates'
import { HotelQuery } from '../base/scopedQuery'

export type RoomOperationalBlockRow = typeof roomOperationalBlock.$inferSelect
/**
 * `organizationId`/`hotelId` come from the scope, never the caller; the cancellation and early-end
 * columns are only ever written by `markCancelled`/`endEarly`, never at insert time.
 */
export type NewRoomOperationalBlock = Omit<typeof roomOperationalBlock.$inferInsert,
  'id' | 'organizationId' | 'hotelId' | 'createdAt' | 'cancelledAt' | 'cancelledBy' | 'cancelReason' | 'endedEarlyAt' | 'endedEarlyBy' | 'originalEndDate'>

export interface BlockActor { id: string, fullName: string }

/** A block row plus what its DTO needs to display it: the room's number and the actors' names (same-organization join, S3 pattern). */
export interface RoomOperationalBlockView {
  block: RoomOperationalBlockRow
  roomNumber: string
  createdBy: BlockActor | null
  cancelledBy: BlockActor | null
  endedEarlyBy: BlockActor | null
}

export interface BlockListFilter {
  /** Inclusive night window: a block is listed when its `[start_date, end_date]` intersects `[from, to]`. */
  from: IsoDate
  to: IsoDate
  roomId?: string
  kind?: BlockKind
  /** Cancelled blocks are excluded unless this is true. Ended-early blocks are not cancelled — they are listed over their actual (shortened) nights. */
  includeCancelled?: boolean
  page: number
  pageSize: number
}

export interface BlockListPage { rows: RoomOperationalBlockView[], total: number }

export interface EndEarlyInput { newEndDate: IsoDate, at: Date, by: string, reason: string }

const createdByUser = alias(appUser, 'block_created_by_user')
const cancelledByUser = alias(appUser, 'block_cancelled_by_user')
const endedEarlyByUser = alias(appUser, 'block_ended_early_by_user')

/** "Active" = not cancelled. An ended-early block stays active over its (shortened) nights. */
const active = () => isNull(roomOperationalBlock.cancelledAt)
/** Still changeable by `markCancelled`/`endEarly`: neither cancelled nor already ended early. */
const changeable = () => and(isNull(roomOperationalBlock.cancelledAt), isNull(roomOperationalBlock.endedEarlyAt))
const intersects = (range: NightRange) => and(lte(roomOperationalBlock.startDate, range.to), gte(roomOperationalBlock.endDate, range.from))

/**
 * Operational blocks (Hotel scope). Every statement carries the organization AND hotel predicate via
 * `HotelQuery` (or `this.q.cond(...)` for the joined reads). There is deliberately NO delete method —
 * blocks are never deleted (D14): an unstarted block is soft-cancelled (`markCancelled`), a running
 * one is shortened to yesterday with its history kept on the row (`endEarly`, S11).
 */
export class OperationalBlockRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  async insert(values: NewRoomOperationalBlock): Promise<RoomOperationalBlockRow> {
    const [row] = await this.q.insert(roomOperationalBlock, values).returning()
    return row!
  }

  /** Multi-row insert for a bulk block — one INSERT statement, every row scoped to the same hotel. */
  async insertMany(valuesList: readonly NewRoomOperationalBlock[]): Promise<RoomOperationalBlockRow[]> {
    if (valuesList.length === 0) return []
    return this.q.insertMany(roomOperationalBlock, valuesList).returning()
  }

  /**
   * One block of this hotel, or null. `forUpdate` row-locks it (cancel/end-early read-then-write): a
   * concurrent cancel of the same block waits here and then re-reads the committed row. Only
   * meaningful inside a transaction.
   */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<RoomOperationalBlockRow | null> {
    const [row] = await this.q.select(roomOperationalBlock, eq(roomOperationalBlock.id, id), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  /** The DTO view (room number + actor names) of the given blocks — used to answer a create/cancel with the written rows. One query. */
  async findViewsByIds(ids: readonly string[]): Promise<RoomOperationalBlockView[]> {
    if (ids.length === 0) return []
    return this.#selectViews(this.q.cond(roomOperationalBlock, inArray(roomOperationalBlock.id, ids as string[])))
  }

  /** Paginated list over a night window — one query for the page, one for the total. Ordered by start date, then room number (natural), then id. */
  async list(filter: BlockListFilter): Promise<BlockListPage> {
    const conditions: Array<SQL | undefined> = [intersects({ from: filter.from, to: filter.to })]
    if (filter.roomId) conditions.push(eq(roomOperationalBlock.roomId, filter.roomId))
    if (filter.kind) conditions.push(eq(roomOperationalBlock.kind, filter.kind))
    if (!filter.includeCancelled) conditions.push(active())
    const where = this.q.cond(roomOperationalBlock, ...conditions)

    const rows = await this.#selectViews(where, { limit: filter.pageSize, offset: (filter.page - 1) * filter.pageSize })
    const [totalRow] = await this.db.select({ value: count() }).from(roomOperationalBlock).where(where)
    return { rows, total: Number(totalRow?.value ?? 0) }
  }

  /** Active blocks of the given rooms that share a night with `range` (optionally only of `kinds`) — the friendly BLOCK_OVERLAP pre-check. */
  async findActiveOverlapping(roomIds: readonly string[], range: NightRange, kinds?: readonly BlockKind[]): Promise<RoomOperationalBlockRow[]> {
    if (roomIds.length === 0) return []
    return this.q.select(roomOperationalBlock, and(
      inArray(roomOperationalBlock.roomId, roomIds as string[]),
      active(),
      intersects(range),
      kinds && kinds.length > 0 ? inArray(roomOperationalBlock.kind, kinds as BlockKind[]) : undefined,
    ))
  }

  /** Soft-cancels an unstarted block. Only a still-changeable row is touched; returns the updated row, or null when nothing matched. */
  async markCancelled(id: string, at: Date, by: string, reason: string): Promise<RoomOperationalBlockRow | null> {
    const [row] = await this.q.update(roomOperationalBlock, { cancelledAt: at, cancelledBy: by, cancelReason: reason }, eq(roomOperationalBlock.id, id), changeable()).returning()
    return row ?? null
  }

  /**
   * Ends a running block early (S11) in ONE UPDATE: `original_end_date` takes the row's CURRENT
   * `end_date` (every right-hand side of an UPDATE sees the old row), `end_date` becomes
   * `newEndDate`, and `ended_early_at`/`ended_early_by`/`cancel_reason` are set together — the S11
   * check constraints hold at every instant. Returns the updated row, or null when nothing matched.
   */
  async endEarly(id: string, input: EndEarlyInput): Promise<RoomOperationalBlockRow | null> {
    const [row] = await this.q.update(roomOperationalBlock, {
      endDate: input.newEndDate,
      // An SQL column reference, not a value: HotelQuery.update's `set` is typed by the insert shape
      // (plain values), so the expression is cast — Drizzle renders it verbatim as `"end_date"`.
      originalEndDate: sql`${roomOperationalBlock.endDate}` as unknown as IsoDate,
      endedEarlyAt: input.at,
      endedEarlyBy: input.by,
      cancelReason: input.reason,
    }, eq(roomOperationalBlock.id, id), changeable()).returning()
    return row ?? null
  }

  /** Active blocks of the given rooms covering `date` — room `status` on `asOf` (S5). One query for a whole page of rooms. */
  async findActiveForRoomsOn(roomIds: readonly string[], date: IsoDate): Promise<RoomOperationalBlockRow[]> {
    if (roomIds.length === 0) return []
    return this.q.select(roomOperationalBlock, and(inArray(roomOperationalBlock.roomId, roomIds as string[]), active(), intersects({ from: date, to: date })))
  }

  /** True if the room has an active block ending on or after `date` — the retire guard (409 ROOM_HAS_ACTIVE_BLOCKS). */
  async existsActiveEndingOnOrAfter(roomId: string, date: IsoDate): Promise<boolean> {
    const rows = await this.q.select(roomOperationalBlock, and(eq(roomOperationalBlock.roomId, roomId), active(), gte(roomOperationalBlock.endDate, date)), { limit: 1 })
    return rows.length > 0
  }

  // True JS-private (not TypeScript `private`), so the isolation-registry coverage scan does not see it
  // as a public repository method (same as AuditRepository#list). `where` must already carry the
  // scope predicate (`this.q.cond(...)`); the joins themselves are constrained to the same
  // organization (and, for the room, the same hotel), so a stray id can never resolve across tenants.
  async #selectViews(where: SQL, page?: { limit: number, offset: number }): Promise<RoomOperationalBlockView[]> {
    const orgId = this.scope.organizationId
    let query = this.db
      .select({
        block: roomOperationalBlock,
        roomNumber: room.roomNumber,
        createdById: createdByUser.id,
        createdByName: createdByUser.fullName,
        cancelledById: cancelledByUser.id,
        cancelledByName: cancelledByUser.fullName,
        endedEarlyById: endedEarlyByUser.id,
        endedEarlyByName: endedEarlyByUser.fullName,
      })
      .from(roomOperationalBlock)
      .innerJoin(room, and(eq(room.id, roomOperationalBlock.roomId), eq(room.organizationId, orgId), eq(room.hotelId, this.scope.hotelId)))
      .leftJoin(createdByUser, and(eq(createdByUser.id, roomOperationalBlock.createdBy), eq(createdByUser.organizationId, orgId)))
      .leftJoin(cancelledByUser, and(eq(cancelledByUser.id, roomOperationalBlock.cancelledBy), eq(cancelledByUser.organizationId, orgId)))
      .leftJoin(endedEarlyByUser, and(eq(endedEarlyByUser.id, roomOperationalBlock.endedEarlyBy), eq(endedEarlyByUser.organizationId, orgId)))
      .where(where)
      .orderBy(asc(roomOperationalBlock.startDate), sql`length(${room.roomNumber})`, asc(room.roomNumber), asc(roomOperationalBlock.id))
      .$dynamic()
    if (page) query = query.limit(page.limit).offset(page.offset)

    const rows = await query
    const actor = (id: string | null, fullName: string | null): BlockActor | null => (id && fullName !== null ? { id, fullName } : null)
    return rows.map(r => ({
      block: r.block,
      roomNumber: r.roomNumber,
      createdBy: actor(r.createdById, r.createdByName),
      cancelledBy: actor(r.cancelledById, r.cancelledByName),
      endedEarlyBy: actor(r.endedEarlyById, r.endedEarlyByName),
    }))
  }
}
