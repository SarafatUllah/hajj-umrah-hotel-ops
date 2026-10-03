import { and, asc, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { DbOrTx } from '../../../db/client'
import { room, roomBaseConfig, roomCapacityOverride, roomOperationalBlock } from '../../../db/schema'
import type { HotelScope } from '../../security/scope'
import type { BlockKind } from '../../../shared/constants/inventory'
import { type NightRange, toEpochDay } from '../../../shared/utils/dates'
import type { RoomCalendarInput } from '../../domain/inventory/calendar'
import { HotelQuery } from '../base/scopedQuery'

export interface LoadRoomInputsOptions {
  /** Restrict to these rooms (still hotel-scoped: an id of another hotel/organization simply never comes back). `[]` loads nothing. */
  roomIds?: readonly string[]
  /** Also load the rooms' ACTIVE (non-cancelled) blocks overlapping the range (any of its windows); otherwise every `blocks` is `[]`. */
  includeBlocks: boolean
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
   */
  async loadRoomInputs(range: NightRange | readonly NightRange[], opts: LoadRoomInputsOptions = { includeBlocks: false }): Promise<InventoryRoomInput[]> {
    const windows = mergeWindows(Array.isArray(range) ? range : [range as NightRange])
    if (windows.length === 0) return []
    if (opts.roomIds && opts.roomIds.length === 0) return []
    const ids = opts.roomIds ? [...new Set(opts.roomIds)] : undefined
    const onlyRooms = (column: AnyPgColumn) => (ids ? inArray(column, ids) : undefined)

    const [roomRows, versionRows, overrideRows, blockRows] = await Promise.all([
      // Deliberately NOT a correlated `EXISTS (… room_base_config …)`: on freshly bulk-loaded tables
      // (no planner statistics yet) PostgreSQL chose a quadratic nested-loop semi join for it (measured:
      // 4M rows filtered, ~440 ms for 2,000 rooms). The "has a base version overlapping `range`" rule is
      // applied below from the versions query instead, which selects exactly those versions.
      this.db
        .select({ id: room.id, roomNumber: room.roomNumber, floorId: room.floorId, roomTypeId: room.roomTypeId })
        .from(room)
        .where(this.q.cond(room, onlyRooms(room.id)))
        .orderBy(sql`length(${room.roomNumber})`, asc(room.roomNumber), asc(room.id)),
      this.db
        .select({ roomId: roomBaseConfig.roomId, validFrom: roomBaseConfig.validFrom, validTo: roomBaseConfig.validTo, physicalBeds: roomBaseConfig.physicalBeds, sellableCapacity: roomBaseConfig.sellableCapacity })
        .from(roomBaseConfig)
        .where(this.q.cond(roomBaseConfig, onlyRooms(roomBaseConfig.roomId), anyWindow(windows, baseOverlaps)))
        .orderBy(asc(roomBaseConfig.roomId), asc(roomBaseConfig.validFrom)),
      this.db
        .select({ roomId: roomCapacityOverride.roomId, periodId: roomCapacityOverride.periodId, validFrom: roomCapacityOverride.validFrom, validTo: roomCapacityOverride.validTo, physicalBeds: roomCapacityOverride.physicalBeds, sellableCapacity: roomCapacityOverride.sellableCapacity })
        .from(roomCapacityOverride)
        .where(this.q.cond(roomCapacityOverride, onlyRooms(roomCapacityOverride.roomId), anyWindow(windows, overrideOverlaps)))
        .orderBy(asc(roomCapacityOverride.roomId), asc(roomCapacityOverride.validFrom)),
      opts.includeBlocks
        ? this.db
            .select({ id: roomOperationalBlock.id, roomId: roomOperationalBlock.roomId, kind: roomOperationalBlock.kind, startDate: roomOperationalBlock.startDate, endDate: roomOperationalBlock.endDate })
            .from(roomOperationalBlock)
            .where(this.q.cond(roomOperationalBlock, onlyRooms(roomOperationalBlock.roomId), isNull(roomOperationalBlock.cancelledAt), anyWindow(windows, blockOverlaps)))
            .orderBy(asc(roomOperationalBlock.roomId), asc(roomOperationalBlock.startDate), asc(roomOperationalBlock.id))
        : Promise.resolve([]),
    ])

    const byRoom = new Map<string, InventoryRoomInput>()
    for (const r of roomRows) {
      byRoom.set(r.id, { roomId: r.id, roomNumber: r.roomNumber, floorId: r.floorId, roomTypeId: r.roomTypeId, versions: [], overrides: [], blocks: [] })
    }
    // The four statements are not one snapshot: a row whose room is absent from the room query (a
    // concurrent write between statements) is dropped rather than creating a room out of nowhere.
    for (const v of versionRows) byRoom.get(v.roomId)?.versions.push({ validFrom: v.validFrom, validTo: v.validTo, physicalBeds: v.physicalBeds, sellableCapacity: v.sellableCapacity })
    for (const o of overrideRows) byRoom.get(o.roomId)?.overrides.push({ periodId: o.periodId, validFrom: o.validFrom, validTo: o.validTo, physicalBeds: o.physicalBeds, sellableCapacity: o.sellableCapacity })
    for (const b of blockRows) byRoom.get(b.roomId)?.blocks.push({ id: b.id, kind: b.kind as BlockKind, from: b.startDate, to: b.endDate })
    // Only rooms with a base version overlapping `range` (i.e. in inventory on at least one night of it).
    return [...byRoom.values()].filter(r => r.versions.length > 0)
  }
}
