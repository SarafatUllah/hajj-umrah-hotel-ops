import { and, asc, count, eq, gte, ilike, inArray, isNull, lte, not, or, sql, type SQL } from 'drizzle-orm'
import type { DbOrTx } from '../../../db/client'
import { floor, room, roomBaseConfig } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import type { IsoDate } from '../../../shared/utils/dates'
import { HotelQuery } from '../base/scopedQuery'

export type RoomRow = typeof room.$inferSelect
/** `organizationId`/`hotelId` are supplied by the scope, never the caller (HotelQuery.insert). */
export type NewRoom = Omit<typeof room.$inferInsert, 'organizationId' | 'hotelId'>
/**
 * `id`/`organizationId`/`hotelId`/`createdAt` are never client-settable via a patch, and — the
 * structural half of D16's room-number-immutability rule — `roomNumber` is not part of this type
 * either, so no `update()` call anywhere in this codebase can even type-check a `roomNumber`
 * assignment. The only place `room.room_number` is ever written is the initial `insert`.
 */
export type RoomPatch = Partial<Omit<typeof room.$inferInsert, 'id' | 'organizationId' | 'hotelId' | 'roomNumber' | 'createdAt'>>

export interface RoomListFilter {
  floorId?: string
  roomTypeId?: string
  /** Case-insensitive PREFIX match on `room_number`; `%`/`_`/`\` are escaped before building the pattern. */
  q?: string
  inventory?: 'IN' | 'OUT' | 'ALL'
  asOf: IsoDate
  page: number
  pageSize: number
}

export interface RoomPage {
  rows: RoomRow[]
  total: number
}

/** Escapes LIKE/ILIKE metacharacters so a client-supplied `q` (e.g. `%`) is matched LITERALLY, never as a wildcard. Also used by Task 18's `InventoryReadRepository.listRoomCandidates`. */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** A room's base-config version covers `asOf` when `valid_from <= asOf <= valid_to` (or `valid_to IS NULL`, open-ended). */
function coveringVersion(asOf: IsoDate): SQL {
  return and(eq(roomBaseConfig.roomId, room.id), lte(roomBaseConfig.validFrom, asOf), or(isNull(roomBaseConfig.validTo), gte(roomBaseConfig.validTo, asOf)))!
}

function coveringVersionExists(asOf: IsoDate): SQL {
  return sql`EXISTS (SELECT 1 FROM ${roomBaseConfig} WHERE ${eq(roomBaseConfig.roomId, room.id)} AND ${lte(roomBaseConfig.validFrom, asOf)} AND (${isNull(roomBaseConfig.validTo)} OR ${gte(roomBaseConfig.validTo, asOf)}))`
}

export class RoomRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  async insert(values: NewRoom): Promise<RoomRow> {
    const [row] = await this.q.insert(room, values).returning()
    return row!
  }

  /** Multi-row insert for bulk creation — one INSERT statement, all rows scoped to the same hotel. */
  async insertMany(valuesList: readonly NewRoom[]): Promise<RoomRow[]> {
    if (valuesList.length === 0) return []
    return this.q.insertMany(room, valuesList).returning()
  }

  /**
   * One room of this hotel, or null. `forUpdate` row-locks it: the room row is the serialization
   * point for every write that changes or depends on the room's dated inventory (retirement vs.
   * block create / override apply) — a concurrent writer of the same room waits here and then
   * reads the committed state. Only meaningful inside a transaction.
   */
  async findById(id: string, options: { forUpdate?: boolean } = {}): Promise<RoomRow | null> {
    const [row] = await this.q.select(room, eq(room.id, id), { limit: 1, forUpdate: options.forUpdate })
    return row ?? null
  }

  /**
   * Row-locks (`FOR UPDATE`) every room of this hotel among `ids` in ONE statement and returns them,
   * ordered by id. The ids are de-duplicated and the statement is `ORDER BY id`, so PostgreSQL
   * acquires the row locks in ascending-id order — every multi-room locker (bulk block create,
   * override apply) takes them in the same global order, so two of them can never deadlock on each
   * other's rooms. An id that is not a room of this hotel is simply absent from the result (and never
   * locked): the scope predicate is part of the locked statement itself. Only meaningful inside a
   * transaction.
   */
  async lockByIds(ids: readonly string[]): Promise<RoomRow[]> {
    const unique = [...new Set(ids)].sort()
    if (unique.length === 0) return []
    return this.q.select(room, inArray(room.id, unique), { orderBy: [asc(room.id)], forUpdate: true })
  }

  /** `roomNumber` must already be normalized (`normalizeRoomNumber`) — this is an exact-match lookup, used for the lifetime-uniqueness check. */
  async findByNumber(roomNumber: string): Promise<RoomRow | null> {
    const [row] = await this.q.select(room, eq(room.roomNumber, roomNumber), { limit: 1 })
    return row ?? null
  }

  /** Batched lifetime-uniqueness check for bulk create — one query for every normalized number in the request. */
  async findByNumbers(roomNumbers: readonly string[]): Promise<RoomRow[]> {
    if (roomNumbers.length === 0) return []
    return this.q.select(room, inArray(room.roomNumber, roomNumbers as string[]))
  }

  /**
   * Filtered, paginated room list. Ordering is `floor.level, length(room_number), room_number, id` —
   * the `length()` term makes numeric-looking room numbers sort naturally (`2`, `10`, `101`) instead
   * of lexicographically (`10`, `101`, `2`). `inventory` is evaluated at `filter.asOf` via a
   * correlated EXISTS/NOT EXISTS against `room_base_config` (never a per-room follow-up query).
   */
  async listPage(filter: RoomListFilter): Promise<RoomPage> {
    const conditions: SQL[] = []
    if (filter.floorId) conditions.push(eq(room.floorId, filter.floorId))
    if (filter.roomTypeId) conditions.push(eq(room.roomTypeId, filter.roomTypeId))
    if (filter.q) conditions.push(ilike(room.roomNumber, `${escapeLikePattern(filter.q)}%`))
    if (filter.inventory === 'IN') conditions.push(coveringVersionExists(filter.asOf))
    else if (filter.inventory === 'OUT') conditions.push(not(coveringVersionExists(filter.asOf)))

    const where = this.q.cond(room, ...conditions)

    const rows = await this.db
      .select({
        id: room.id,
        organizationId: room.organizationId,
        hotelId: room.hotelId,
        floorId: room.floorId,
        roomTypeId: room.roomTypeId,
        roomNumber: room.roomNumber,
        features: room.features,
        notes: room.notes,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      })
      .from(room)
      .innerJoin(floor, eq(floor.id, room.floorId))
      .where(where)
      .orderBy(asc(floor.level), sql`length(${room.roomNumber})`, asc(room.roomNumber), asc(room.id))
      .limit(filter.pageSize)
      .offset((filter.page - 1) * filter.pageSize)

    const [totalRow] = await this.db.select({ value: count() }).from(room).where(where)

    return { rows, total: Number(totalRow?.value ?? 0) }
  }

  async update(id: string, patch: RoomPatch): Promise<void> {
    await this.q.update(room, patch, eq(room.id, id))
  }

  /** Every room on `floorId`, unpaginated (a floor's room count is never large) — used by the floor-deactivation guard. */
  async listAllOnFloor(floorId: string): Promise<RoomRow[]> {
    return this.q.select(room, eq(room.floorId, floorId))
  }

  /** Rooms in inventory (a base-config version covering `asOf`) across the whole hotel — one query. */
  async countInInventory(asOf: IsoDate): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(room)
      .innerJoin(roomBaseConfig, coveringVersion(asOf))
      .where(and(eq(room.organizationId, this.scope.organizationId), eq(room.hotelId, this.scope.hotelId)))
    return Number(row?.value ?? 0)
  }

  /** Same as `countInInventory`, restricted to one floor — one query. */
  async countInInventoryOnFloor(floorId: string, asOf: IsoDate): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(room)
      .innerJoin(roomBaseConfig, coveringVersion(asOf))
      .where(and(eq(room.organizationId, this.scope.organizationId), eq(room.hotelId, this.scope.hotelId), eq(room.floorId, floorId)))
    return Number(row?.value ?? 0)
  }

  /** In-inventory room counts for EVERY floor of this hotel, grouped in ONE query (never one per floor). */
  async countInInventoryByFloor(asOf: IsoDate): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ floorId: room.floorId, value: count() })
      .from(room)
      .innerJoin(roomBaseConfig, coveringVersion(asOf))
      .where(and(eq(room.organizationId, this.scope.organizationId), eq(room.hotelId, this.scope.hotelId)))
      .groupBy(room.floorId)
    return new Map(rows.map(r => [r.floorId, Number(r.value)]))
  }

  /** Ids of every room in inventory (a base-config version covering `date`) — Task 15's preview `hotelTotals` (S6), one query. */
  async idsInInventoryOn(date: IsoDate): Promise<string[]> {
    const rows = await this.db
      .select({ id: room.id })
      .from(room)
      .innerJoin(roomBaseConfig, coveringVersion(date))
      .where(and(eq(room.organizationId, this.scope.organizationId), eq(room.hotelId, this.scope.hotelId)))
    return rows.map(r => r.id)
  }

  /**
   * Bulk id lookup, hotel-scoped — Task 15's `roomIds` override selector resolves and validates in
   * ONE query: any requested id that doesn't come back does not belong to this hotel (422
   * `INVALID_REFERENCE`), exactly like `findByNumbers`' bulk-create pattern.
   */
  async findByIds(ids: readonly string[]): Promise<RoomRow[]> {
    if (ids.length === 0) return []
    return this.q.select(room, inArray(room.id, ids as string[]))
  }

  /** Every room on any of `floorIds` — Task 15's `floorIds` override selector, one query. */
  async listByFloorIds(floorIds: readonly string[]): Promise<RoomRow[]> {
    if (floorIds.length === 0) return []
    return this.q.select(room, inArray(room.floorId, floorIds as string[]))
  }

  /** Every room of any of `roomTypeIds` — Task 15's `roomTypeIds` override selector, one query. */
  async listByRoomTypeIds(roomTypeIds: readonly string[]): Promise<RoomRow[]> {
    if (roomTypeIds.length === 0) return []
    return this.q.select(room, inArray(room.roomTypeId, roomTypeIds as string[]))
  }

  /** Every room of this hotel, unpaginated — Task 15's `{ all: true }` override selector. */
  async listAll(): Promise<RoomRow[]> {
    return this.q.select(room)
  }
}
