import { type IsoDate, type NightRange, eachDate, fromEpochDay, toEpochDay } from '../../../shared/utils/dates'
import { type CapacitySource, cutPoints, effectiveCapacityAt } from './capacity'
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

function blockCovers(b: BlockInput, day: number): boolean {
  return toEpochDay(b.from) <= day && day <= toEpochDay(b.to)
}

function stateAt(input: RoomCalendarInput, date: IsoDate, options: CalendarOptions): Omit<CalendarSegment, 'from' | 'to'> {
  const cap = effectiveCapacityAt(input.versions, input.overrides, date)
  if (!cap) {
    return { status: 'NOT_IN_INVENTORY', sellable: false, physicalBeds: null, sellableCapacity: null, capacitySource: null, periodId: null, blockIds: [] }
  }
  const day = toEpochDay(date)
  const covering = input.blocks.filter(b => blockCovers(b, day))
  let status: InventoryStatus = 'AVAILABLE'
  for (const b of covering) if (rank(b.kind) < rank(status)) status = b.kind
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

const sameState = (a: Omit<CalendarSegment, 'from' | 'to'>, b: Omit<CalendarSegment, 'from' | 'to'>) =>
  a.status === b.status && a.sellable === b.sellable && a.physicalBeds === b.physicalBeds && a.sellableCapacity === b.sellableCapacity
  && a.capacitySource === b.capacitySource && a.periodId === b.periodId && a.blockIds.join() === b.blockIds.join()

/** Run-length-encoded calendar row for one room. Every night of `range` is covered by exactly one segment. */
export function buildRoomSegments(input: RoomCalendarInput, range: NightRange, options: CalendarOptions): CalendarSegment[] {
  const points = cutPoints(range, [
    ...input.versions.map(v => ({ from: v.validFrom, to: v.validTo })),
    ...input.overrides.map(o => ({ from: o.validFrom, to: o.validTo })),
    ...input.blocks.map(b => ({ from: b.from, to: b.to })),
  ])
  const end = toEpochDay(range.to)
  const out: CalendarSegment[] = []
  points.forEach((s, i) => {
    const e = (points[i + 1] ?? end + 1) - 1
    const state = stateAt(input, fromEpochDay(s), options)
    const last = out[out.length - 1]
    if (last && sameState(last, state)) last.to = fromEpochDay(e)
    else out.push({ from: fromEpochDay(s), to: fromEpochDay(e), ...state })
  })
  return out
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
  for (const room of rooms) {
    for (const seg of buildRoomSegments(room, range, options)) {
      if (seg.status === 'NOT_IN_INVENTORY') continue
      const from = toEpochDay(seg.from) - start
      const to = toEpochDay(seg.to) - start
      for (let i = from; i <= to; i++) {
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
