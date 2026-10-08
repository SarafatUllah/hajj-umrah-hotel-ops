import { and, asc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../../../db/client'
import { capacityPeriod, floor, room, roomBaseConfig, roomCapacityOverride, roomOperationalBlock, roomType } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import type { BlockKind, CapacityPeriodKind } from '../../../shared/constants/inventory'
import { type IsoDate, type NightRange, toEpochDay } from '../../../shared/utils/dates'
import type { RoomCalendarInput } from '../../domain/inventory/calendar'
import { HotelQuery, OrgQuery } from '../base/scopedQuery'
import { escapeLikePattern } from './roomRepository'

export interface LoadRoomInputsOptions {
  /** Restrict to these rooms (still hotel-scoped: an id of another hotel/organization simply never comes back). `[]` loads nothing. */
  roomIds?: readonly string[]
  /** Also load the rooms' ACTIVE (non-cancelled) blocks overlapping the range (any of its windows); otherwise every `blocks` is `[]`. */
  includeBlocks: boolean
  /**
   * Task 18: room rows ALREADY read from this hotel (e.g. by `listRoomCandidates`, in its order). The
   * rooms statement is then skipped and exactly these rooms are assembled, in this order; rows of any
   * other room are dropped. `[]` loads nothing. `roomIds` (if given) still restricts the range
   * statements in SQL.
   */
  rooms?: readonly InventoryRoomRow[]
  /**
   * Task 18: also return rooms WITHOUT a base version overlapping the range (their calendar is
   * `NOT_IN_INVENTORY` throughout). Default `false`: only rooms in inventory on at least one night.
   */
  includeOutOfInventory?: boolean
  /**
   * Task 18 (S13): also return `refs` — the period (name, kind, dates) of every loaded override and
   * the kind, dates and reason of every loaded block — read by the SAME override statement (joined to
   * `capacity_period`) and block statement (also selecting `reason`): no statement is added.
   */
  withRefs?: boolean
}

/** The identifying columns of a room, as the rooms statement (or `listRoomCandidates`) reads them. */
export interface InventoryRoomRow {
  id: string
  roomNumber: string
  floorId: string
  roomTypeId: string
}

/** Task 18: one calendar row's room — the room joined to its floor and room type, read in ONE statement. */
export interface RoomCandidate extends InventoryRoomRow {
  features: string[]
  floor: { id: string, level: number, label: string }
  roomType: { id: string, code: string, name: string }
}

/** Task 18: structural (SQL) calendar filters. `q` is a case-insensitive room-number PREFIX, matched literally (`%`, `_` and backslash escaped). */
export interface RoomCandidateFilter {
  floorId?: string
  roomTypeId?: string
  q?: string
  /** Restrict to these rooms (still hotel-scoped: another hotel's id never comes back). `[]` reads nothing. At most ~5,000 ids are meant to be passed (they are bound parameters). */
  roomIds?: readonly string[]
  /** Return at most this many rows — the FIRST ones in the calendar's order (a `LIMIT`, so the statement never reads out the whole room list). */
  limit?: number
  /** Skip this many rows of the ordered result (with `limit`: one page of it). */
  offset?: number
}

export interface PeriodRefRow { name: string, kind: CapacityPeriodKind, startDate: IsoDate, endDate: IsoDate }
export interface BlockRefRow { kind: BlockKind, startDate: IsoDate, endDate: IsoDate, reason: string }

/** Every period / block referenced by a loaded override / block row of the returned rooms, by id. */
export interface InventoryRefs {
  periods: Map<string, PeriodRefRow>
  blocks: Map<string, BlockRefRow>
}

export interface RoomInputsWithRefs {
  rooms: InventoryRoomInput[]
  refs: InventoryRefs
}

/** The pure calendar input of one room, plus the room's own identifying columns read by the same query. */
export interface InventoryRoomInput extends RoomCalendarInput {
  roomNumber: string
  floorId: string
  roomTypeId: string
}

/**
 * The windows sorted and merged (overlapping or adjacent windows become one), so each statement gets
 * one overlap predicate per DISJOINT window. Far-apart windows stay separate: rows lying only in the
 * gap between them are never loaded (rows loaded are bounded by the windows' total length, not by
 * the distance between them).
 */
function mergeWindows(windows: readonly NightRange[]): NightRange[] {
  const sorted = [...windows].sort((a, b) => toEpochDay(a.from) - toEpochDay(b.from))
  const out: NightRange[] = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && toEpochDay(w.from) <= toEpochDay(last.to) + 1) {
      if (toEpochDay(w.to) > toEpochDay(last.to)) last.to = w.to
    }
    else {
      out.push({ from: w.from, to: w.to })
    }
  }
  return out
}

/** `(overlaps w1) OR (overlaps w2) …` — just `overlaps w` for a single window. */
function anyWindow(windows: readonly NightRange[], overlaps: (w: NightRange) => SQL): SQL {
  const parts = windows.map(overlaps)
  return parts.length === 1 ? parts[0]! : or(...parts)!
}

/** `valid_from <= w.to AND (valid_to IS NULL OR valid_to >= w.from)` — an inclusive night-range overlap. */
function baseOverlaps(w: NightRange): SQL {
  return and(lte(roomBaseConfig.validFrom, w.to), or(isNull(roomBaseConfig.validTo), gte(roomBaseConfig.validTo, w.from)))!
}

function overrideOverlaps(w: NightRange): SQL {
  return and(lte(roomCapacityOverride.validFrom, w.to), gte(roomCapacityOverride.validTo, w.from))!
}

function blockOverlaps(w: NightRange): SQL {
  return and(lte(roomOperationalBlock.startDate, w.to), gte(roomOperationalBlock.endDate, w.from))!
}

/** An override row as either override statement returns it (the period columns only with `withRefs`). */
interface OverrideRow {
  roomId: string
  periodId: string
  validFrom: IsoDate
  validTo: IsoDate
  physicalBeds: number
  sellableCapacity: number
  periodName?: string
  periodKind?: string
  periodStart?: IsoDate
  periodEnd?: IsoDate
}

/** A block row as either block statement returns it (`reason` only with `withRefs`). */
interface BlockRow { id: string, roomId: string, kind: string, startDate: IsoDate, endDate: IsoDate, reason?: string }

/**
 * The single read path for derived inventory (Task 17 averages; Task 18's calendar extends it). Every
 * statement carries the organization AND hotel predicate (`HotelQuery.cond`). Read-only: there is
 * no write method here.
 */
export class InventoryReadRepository {
  private readonly q: HotelQuery

  constructor(private readonly db: DbOrTx, private readonly scope: HotelScope) {
    this.q = new HotelQuery(db, scope)
  }

  /**
   * Every room with a base version overlapping `range`, with its base versions, seasonal overrides and
   * (optionally) active blocks overlapping `range` — FOUR single-table statements in total whatever the
   * room count (three without blocks), never one per room, assembled in memory. Nothing is
   * materialized per day. Rooms are ordered by room number (natural: `length(room_number),
   * room_number`), then id.
   *
   * `range` may be several windows (e.g. a date, a range and a stay that lie far apart): rows
   * overlapping ANY of them are loaded, with the same four statements — never the span between them.
   * Each window's rows are complete, so any per-window computation over the result is exact. `[]`
   * loads nothing.
   *
   * Task 18 extensions (all optional; without them the statements and the result are exactly Task
   * 17's): `rooms` supplies already-read room rows (the rooms statement is skipped — one statement
   * fewer), `includeOutOfInventory` keeps rooms without an overlapping base version, and `withRefs`
   * returns `{ rooms, refs }` where the override statement is joined to `capacity_period` (itself
   * scoped to the organization AND hotel) and the block statement also selects `reason`.
   */
  async loadRoomInputs(range: NightRange | readonly NightRange[], opts: LoadRoomInputsOptions & { withRefs: true }): Promise<RoomInputsWithRefs>
  async loadRoomInputs(range: NightRange | readonly NightRange[], opts?: LoadRoomInputsOptions & { withRefs?: false }): Promise<InventoryRoomInput[]>
  async loadRoomInputs(range: NightRange | readonly NightRange[], opts: LoadRoomInputsOptions = { includeBlocks: false }): Promise<InventoryRoomInput[] | RoomInputsWithRefs> {
    const refs: InventoryRefs = { periods: new Map(), blocks: new Map() }
    const done = (rooms: InventoryRoomInput[]) => (opts.withRefs ? { rooms, refs } : rooms)

    const windows = mergeWindows(Array.isArray(range) ? range : [range as NightRange])
    if (windows.length === 0) return done([])
    if (opts.roomIds && opts.roomIds.length === 0) return done([])
    if (opts.rooms && opts.rooms.length === 0) return done([])
    const ids = opts.roomIds ? [...new Set(opts.roomIds)] : undefined
    const onlyRooms = (column: AnyPgColumn) => (ids ? inArray(column, ids) : undefined)

    const overrideWhere = this.q.cond(roomCapacityOverride, onlyRooms(roomCapacityOverride.roomId), anyWindow(windows, overrideOverlaps))
    const overrideOrder = [asc(roomCapacityOverride.roomId), asc(roomCapacityOverride.validFrom)]
    const blockWhere = this.q.cond(roomOperationalBlock, onlyRooms(roomOperationalBlock.roomId), isNull(roomOperationalBlock.cancelledAt), anyWindow(windows, blockOverlaps))
    const blockOrder = [asc(roomOperationalBlock.roomId), asc(roomOperationalBlock.startDate), asc(roomOperationalBlock.id)]

    const [roomRows, versionRows, overrideRows, blockRows] = await Promise.all([
      // Deliberately NOT a correlated `EXISTS (… room_base_config …)`: on freshly bulk-loaded tables
      // (no planner statistics yet) PostgreSQL chose a quadratic nested-loop semi join for it (measured:
      // 4M rows filtered, ~440 ms for 2,000 rooms). The "has a base version overlapping `range`" rule is
      // applied below from the versions query instead, which selects exactly those versions.
      opts.rooms
        ? Promise.resolve(opts.rooms)
        : this.db
            .select({ id: room.id, roomNumber: room.roomNumber, floorId: room.floorId, roomTypeId: room.roomTypeId })
            .from(room)
            .where(this.q.cond(room, onlyRooms(room.id)))
            .orderBy(sql`length(${room.roomNumber})`, asc(room.roomNumber), asc(room.id)),
      this.db
        .select({ roomId: roomBaseConfig.roomId, validFrom: roomBaseConfig.validFrom, validTo: roomBaseConfig.validTo, physicalBeds: roomBaseConfig.physicalBeds, sellableCapacity: roomBaseConfig.sellableCapacity })
        .from(roomBaseConfig)
        .where(this.q.cond(roomBaseConfig, onlyRooms(roomBaseConfig.roomId), anyWindow(windows, baseOverlaps)))
        .orderBy(asc(roomBaseConfig.roomId), asc(roomBaseConfig.validFrom)),
      opts.withRefs
        ? this.db
            .select({ roomId: roomCapacityOverride.roomId, periodId: roomCapacityOverride.periodId, validFrom: roomCapacityOverride.validFrom, validTo: roomCapacityOverride.validTo, physicalBeds: roomCapacityOverride.physicalBeds, sellableCapacity: roomCapacityOverride.sellableCapacity, periodName: capacityPeriod.name, periodKind: capacityPeriod.kind, periodStart: capacityPeriod.startDate, periodEnd: capacityPeriod.endDate })
            .from(roomCapacityOverride)
            // The joined table is scoped by its OWN organization_id AND hotel_id too (never only through the FK).
            .innerJoin(capacityPeriod, this.q.cond(capacityPeriod, eq(capacityPeriod.id, roomCapacityOverride.periodId)))
            .where(overrideWhere)
            .orderBy(...overrideOrder)
        : this.db
            .select({ roomId: roomCapacityOverride.roomId, periodId: roomCapacityOverride.periodId, validFrom: roomCapacityOverride.validFrom, validTo: roomCapacityOverride.validTo, physicalBeds: roomCapacityOverride.physicalBeds, sellableCapacity: roomCapacityOverride.sellableCapacity })
            .from(roomCapacityOverride)
            .where(overrideWhere)
            .orderBy(...overrideOrder),
      !opts.includeBlocks
        ? Promise.resolve([])
        : opts.withRefs
          ? this.db
              .select({ id: roomOperationalBlock.id, roomId: roomOperationalBlock.roomId, kind: roomOperationalBlock.kind, startDate: roomOperationalBlock.startDate, endDate: roomOperationalBlock.endDate, reason: roomOperationalBlock.reason })
              .from(roomOperationalBlock)
              .where(blockWhere)
              .orderBy(...blockOrder)
          : this.db
              .select({ id: roomOperationalBlock.id, roomId: roomOperationalBlock.roomId, kind: roomOperationalBlock.kind, startDate: roomOperationalBlock.startDate, endDate: roomOperationalBlock.endDate })
              .from(roomOperationalBlock)
              .where(blockWhere)
              .orderBy(...blockOrder),
    ])

    const byRoom = new Map<string, InventoryRoomInput>()
    for (const r of roomRows) {
      byRoom.set(r.id, { roomId: r.id, roomNumber: r.roomNumber, floorId: r.floorId, roomTypeId: r.roomTypeId, versions: [], overrides: [], blocks: [] })
    }
    // The four statements are not one snapshot: a row whose room is absent from the room query (a
    // concurrent write between statements) is dropped rather than creating a room out of nowhere.
    for (const v of versionRows) byRoom.get(v.roomId)?.versions.push({ validFrom: v.validFrom, validTo: v.validTo, physicalBeds: v.physicalBeds, sellableCapacity: v.sellableCapacity })
    for (const o of overrideRows as OverrideRow[]) {
      const target = byRoom.get(o.roomId)
      if (!target) continue
      target.overrides.push({ periodId: o.periodId, validFrom: o.validFrom, validTo: o.validTo, physicalBeds: o.physicalBeds, sellableCapacity: o.sellableCapacity })
      if (o.periodName !== undefined) refs.periods.set(o.periodId, { name: o.periodName, kind: o.periodKind as CapacityPeriodKind, startDate: o.periodStart!, endDate: o.periodEnd! })
    }
    for (const b of blockRows as BlockRow[]) {
      const target = byRoom.get(b.roomId)
      if (!target) continue
      target.blocks.push({ id: b.id, kind: b.kind as BlockKind, from: b.startDate, to: b.endDate })
      if (b.reason !== undefined) refs.blocks.set(b.id, { kind: b.kind as BlockKind, startDate: b.startDate, endDate: b.endDate, reason: b.reason })
    }
    // Only rooms with a base version overlapping `range` (i.e. in inventory on at least one night of
    // it) — unless the caller asked for out-of-inventory rooms too.
    const rooms = [...byRoom.values()]
    return done(opts.includeOutOfInventory ? rooms : rooms.filter(r => r.versions.length > 0))
  }

  /**
   * Task 18: the calendar's candidate rooms — the structural filters (`floorId`, `roomTypeId`, the
   * `q` room-number prefix) in SQL, each room joined to its floor and room type, in the calendar's
   * order (`floor.level, length(room_number), room_number, id`). ONE statement; every table in it
   * carries its own scope predicate (room and floor: organization AND hotel; room_type, an
   * organization-level table: organization). Inventory state is NOT filtered here and `room_base_config` is never
   * joined (see `listRoomIdsInInventory`, and `loadRoomInputs`, which derives it from the versions
   * statement — a join/EXISTS/IN on the versions chose quadratic nested loops on tables without
   * statistics: measured up to 165 s for 50,000 rooms). `limit`/`offset` bound what a caller reads.
   */
  async listRoomCandidates(filter: RoomCandidateFilter = {}): Promise<RoomCandidate[]> {
    if (filter.roomIds && filter.roomIds.length === 0) return []
    const ordered = this.db
      .select({
        id: room.id,
        roomNumber: room.roomNumber,
        floorId: room.floorId,
        roomTypeId: room.roomTypeId,
        features: room.features,
        floorLevel: floor.level,
        floorLabel: floor.label,
        roomTypeCode: roomType.code,
        roomTypeName: roomType.name,
      })
      .from(room)
      .innerJoin(floor, this.q.cond(floor, eq(floor.id, room.floorId)))
      .innerJoin(roomType, new OrgQuery(this.db, this.scope).cond(roomType, eq(roomType.id, room.roomTypeId)))
      .where(this.q.cond(
        room,
        filter.floorId ? eq(room.floorId, filter.floorId) : undefined,
        filter.roomTypeId ? eq(room.roomTypeId, filter.roomTypeId) : undefined,
        filter.q ? ilike(room.roomNumber, `${escapeLikePattern(filter.q)}%`) : undefined,
        filter.roomIds ? inArray(room.id, [...new Set(filter.roomIds)]) : undefined,
      ))
      .orderBy(asc(floor.level), sql`length(${room.roomNumber})`, asc(room.roomNumber), asc(room.id))
    const rows = await (filter.limit === undefined ? ordered : filter.offset ? ordered.limit(filter.limit).offset(filter.offset) : ordered.limit(filter.limit))

    return rows.map(r => ({
      id: r.id,
      roomNumber: r.roomNumber,
      floorId: r.floorId,
      roomTypeId: r.roomTypeId,
      features: r.features,
      floor: { id: r.floorId, level: r.floorLevel, label: r.floorLabel },
      roomType: { id: r.roomTypeId, code: r.roomTypeCode, name: r.roomTypeName },
    }))
  }

  /**
   * Task 18: the ids of the hotel's rooms with a base version overlapping `range` (in inventory on at
   * least one of its nights), ONE single-table statement (never joined to `room`), at most `limit`
   * of them. With `roomIds`, only among those rooms.
   */
  async listRoomIdsInInventory(range: NightRange, opts: { roomIds?: readonly string[], limit?: number } = {}): Promise<string[]> {
    if (opts.roomIds && opts.roomIds.length === 0) return []
    const ids = opts.roomIds ? [...new Set(opts.roomIds)] : undefined
    const query = this.db
      .select({ roomId: roomBaseConfig.roomId })
      .from(roomBaseConfig)
      .where(this.q.cond(roomBaseConfig, ids ? inArray(roomBaseConfig.roomId, ids) : undefined, baseOverlaps(range)))
      .groupBy(roomBaseConfig.roomId)
      .orderBy(asc(roomBaseConfig.roomId))
    return (await (opts.limit === undefined ? query : query.limit(opts.limit))).map(r => r.roomId)
  }
}
