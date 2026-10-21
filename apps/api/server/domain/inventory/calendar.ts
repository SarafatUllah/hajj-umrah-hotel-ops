import { type IsoDate, type NightRange, eachDate, fromEpochDay, toEpochDay } from '../../../shared/utils/dates'
import { type CapacitySource, type PreparedCapacity, capacityOnDay, cutDays, prepareCapacity } from './capacity'
import { type AverageResult, type RoomCapacityInput, makeAverage } from './averages'
import { type BlockKind, type InventoryStatus, INVENTORY_STATUSES } from '../../../shared/constants/inventory'


export interface BlockInput { id: string, kind: BlockKind, from: IsoDate, to: IsoDate }
export interface RoomCalendarInput extends RoomCapacityInput { blocks: BlockInput[] }
export interface CalendarOptions {
  /** hotel_setting inventory.maintenanceBlocksSales: when false a MAINTENANCE block is shown but the room stays sellable. */
  maintenanceBlocksSales: boolean
}

export interface CalendarSegment {
  from: IsoDate
  to: IsoDate
  status: InventoryStatus
  /** Can the room be sold on these nights (in inventory and not covered by a sale-blocking block)? */
  sellable: boolean
  physicalBeds: number | null
  sellableCapacity: number | null
  capacitySource: CapacitySource | null
  periodId: string | null
  blockIds: string[]
}

const rank = (s: InventoryStatus) => INVENTORY_STATUSES.indexOf(s)

type SegmentState = Omit<CalendarSegment, 'from' | 'to'>

/** A block with its dates parsed to epoch days and its status rank looked up, once per room (not once per night examined). */
interface PreparedBlock { from: number, to: number, id: string, kind: BlockKind, rank: number }

function stateOnDay(capacity: PreparedCapacity, blocks: PreparedBlock[], day: number, options: CalendarOptions): SegmentState {
  const cap = capacityOnDay(capacity, day)
  if (!cap) {
    return { status: 'NOT_IN_INVENTORY', sellable: false, physicalBeds: null, sellableCapacity: null, capacitySource: null, periodId: null, blockIds: [] }
  }
  const covering = blocks.filter(b => b.from <= day && day <= b.to)
  let status: InventoryStatus = 'AVAILABLE'
  let statusRank = rank(status)
  for (const b of covering) {
    if (b.rank < statusRank) { status = b.kind; statusRank = b.rank }
  }
  const sellable = !covering.some(b => b.kind !== 'MAINTENANCE' || options.maintenanceBlocksSales)
  return {
    status,
    sellable,
    physicalBeds: cap.physicalBeds,
    sellableCapacity: cap.sellableCapacity,
    capacitySource: cap.source,
    periodId: cap.periodId,
    blockIds: covering.map(b => b.id).sort(),
  }
}

const sameState = (a: SegmentState, b: SegmentState) =>
  a.status === b.status && a.sellable === b.sellable && a.physicalBeds === b.physicalBeds && a.sellableCapacity === b.sellableCapacity
  && a.capacitySource === b.capacitySource && a.periodId === b.periodId && a.blockIds.join() === b.blockIds.join()

/** A run-length segment whose boundaries are epoch days. */
interface DaySegment { from: number, to: number, state: SegmentState }

/**
 * The run-length encoding of one room over `[start, end]` (epoch days). Every date of the room's
 * versions, overrides and blocks is parsed ONCE up front; the per-night evaluation then compares
 * numbers only (the ISO re-parse per boundary per cut point was the whole CPU cost of a 400-day,
 * 2,000-room summary). `buildRoomSegments` and `summarizeDaily` both read this one derivation.
 */
function deriveDaySegments(input: RoomCalendarInput, start: number, end: number, options: CalendarOptions): DaySegment[] {
  const capacity = prepareCapacity(input.versions, input.overrides)
  const blocks: PreparedBlock[] = input.blocks.map(b => ({ from: toEpochDay(b.from), to: toEpochDay(b.to), id: b.id, kind: b.kind, rank: rank(b.kind) }))
  const points = cutDays(start, end, capacity.versions, capacity.overrides, blocks)
  const out: DaySegment[] = []
  points.forEach((s, i) => {
    const e = (points[i + 1] ?? end + 1) - 1
    const state = stateOnDay(capacity, blocks, s, options)
    const last = out[out.length - 1]
    if (last && sameState(last.state, state)) last.to = e
    else out.push({ from: s, to: e, state })
  })
  return out
}

/** Run-length-encoded calendar row for one room. Every night of `range` is covered by exactly one segment. */
export function buildRoomSegments(input: RoomCalendarInput, range: NightRange, options: CalendarOptions): CalendarSegment[] {
  return deriveDaySegments(input, toEpochDay(range.from), toEpochDay(range.to), options)
    .map(seg => ({ from: fromEpochDay(seg.from), to: fromEpochDay(seg.to), ...seg.state }))
}

export interface DailySummary {
  date: IsoDate
  roomsInInventory: number
  sellableRooms: number
  outOfService: number
  maintenance: number
  operationalBlock: number
  effectiveSellableCapacity: number
  sellableRoomCapacity: number
}

export function summarizeDaily(rooms: RoomCalendarInput[], range: NightRange, options: CalendarOptions): DailySummary[] {
  const dates = eachDate(range, 1000)
  const start = toEpochDay(range.from)
  const rows: DailySummary[] = dates.map(date => ({
    date, roomsInInventory: 0, sellableRooms: 0, outOfService: 0, maintenance: 0, operationalBlock: 0, effectiveSellableCapacity: 0, sellableRoomCapacity: 0,
  }))
  const end = toEpochDay(range.to)
  for (const room of rooms) {
    for (const { from: segFrom, to: segTo, state: seg } of deriveDaySegments(room, start, end, options)) {
      if (seg.status === 'NOT_IN_INVENTORY') continue
      for (let i = segFrom - start; i <= segTo - start; i++) {
        const row = rows[i]!
        row.roomsInInventory += 1
        row.effectiveSellableCapacity += seg.sellableCapacity ?? 0
        if (seg.sellable) { row.sellableRooms += 1; row.sellableRoomCapacity += seg.sellableCapacity ?? 0 }
        if (seg.status === 'OUT_OF_SERVICE') row.outOfService += 1
        else if (seg.status === 'MAINTENANCE') row.maintenance += 1
        else if (seg.status === 'OPERATIONAL_BLOCK') row.operationalBlock += 1
      }
    }
  }
  return rows
}

export function matchesStatusFilter(segments: CalendarSegment[], statuses: InventoryStatus[], match: 'any' | 'all'): boolean {
  if (statuses.length === 0) return true
  return match === 'any' ? segments.some(s => statuses.includes(s.status)) : segments.every(s => statuses.includes(s.status))
}

/** True if on any night in the segments the effective sellable capacity is within [min, max]. */
export function matchesCapacityFilter(segments: CalendarSegment[], min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) return true
  return segments.some(s => s.sellableCapacity !== null && (min === undefined || s.sellableCapacity >= min) && (max === undefined || s.sellableCapacity <= max))
}

export interface AvailableStayAverage extends AverageResult { eligibleRoomIds: string[] }

/**
 * Available-Stay Average: over rooms sellable on EVERY night of the stay, the average of each room's
 * minimum sellable capacity across the stay. Reservations join this predicate in Phase 2.
 */
export function availableStayAverage(rooms: RoomCalendarInput[], stay: NightRange, options: CalendarOptions): AvailableStayAverage {
  let total = 0
  const eligible: string[] = []
  for (const room of rooms) {
    const segs = buildRoomSegments(room, stay, options)
    if (!segs.every(s => s.sellable)) continue
    total += Math.min(...segs.map(s => s.sellableCapacity!))
    eligible.push(room.roomId)
  }
  return { ...makeAverage(total, eligible.length, 'ROOMS'), eligibleRoomIds: eligible }
}
