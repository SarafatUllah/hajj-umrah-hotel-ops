import type { CapacityTimelineResult } from '@hajj/contracts/types/inventory'
import { MAX_BULK_ROOMS } from '@hajj/contracts/constants/inventory'
import { addDays, rangeLength, toEpochDay } from '@hajj/contracts/utils/dates'
import { normalizeRoomNumber, roomNumbersOfRange } from '@hajj/contracts/utils/roomNumber'

/** A change in capacity as shown: always signed (+2, −1 reads as −1, 0 as 0). */
export function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

/** The numbering of a bulk room creation as the form holds it: a range, or a pasted list (one per line). */
export interface RoomNumbering { mode: 'range' | 'list', prefix: string, from: number, to: number, pad: number, list: string }

/**
 * The numbers a bulk creation would add, normalized as the API will store them, the problems to fix first, and how
 * many were asked for (`requested` above `MAX_BULK_ROOMS`: nothing is built — a mistyped range must not hang the page).
 */
export interface RoomNumberPreview { numbers: string[], invalid: string[], duplicates: string[], requested: number }

export function roomNumberPreview(numbering: RoomNumbering): RoomNumberPreview {
  const lines = numbering.mode === 'list' ? numbering.list.split('\n').map(line => line.trim()).filter(Boolean) : []
  const requested = numbering.mode === 'range' ? Math.max(0, numbering.to - numbering.from + 1) : lines.length
  if (requested > MAX_BULK_ROOMS) return { numbers: [], invalid: [], duplicates: [], requested }
  const raw = numbering.mode === 'range'
    ? roomNumbersOfRange({ prefix: numbering.prefix || undefined, from: numbering.from, to: numbering.to, pad: numbering.pad || undefined })
    : lines
  const seen = new Set<string>()
  const invalid: string[] = []
  const duplicates = new Set<string>()
  for (const entry of raw) {
    const normalized = normalizeRoomNumber(entry)
    if (!normalized) invalid.push(entry)
    else if (seen.has(normalized)) duplicates.add(normalized)
    else seen.add(normalized)
  }
  return { numbers: [...seen], invalid, duplicates: [...duplicates], requested }
}

/** One part of a room's capacity timeline: its normal capacity, a season's, or nights out of inventory. */
export interface TimelinePart {
  kind: 'NORMAL' | 'SEASON' | 'GAP'
  from: string
  to: string
  nights: number
  physicalBeds: number | null
  sellableCapacity: number | null
  seasonName: string | null
  /** The change from the part before (presentation only: a subtraction), `null` at the start or after a gap. */
  deltaSellable: number | null
  deltaBeds: number | null
  past: boolean
  current: boolean
}

/**
 * The server's capacity segments as timeline parts (§29): each named, the nights between segments (and after the last
 * one) as "not in inventory", the change at each boundary. The server decided every capacity; nothing is recomputed.
 */
export function timelineOf(result: CapacityTimelineResult): TimelinePart[] {
  const today = toEpochDay(result.meta.today)
  const part = (kind: TimelinePart['kind'], from: string, to: string, values: Partial<TimelinePart> = {}): TimelinePart => ({
    kind, from, to, nights: rangeLength({ from, to }), physicalBeds: null, sellableCapacity: null, seasonName: null, deltaSellable: null, deltaBeds: null,
    past: toEpochDay(to) < today, current: toEpochDay(from) <= today && today <= toEpochDay(to), ...values,
  })
  const parts: TimelinePart[] = []
  let cursor = result.range.from
  let previous: TimelinePart | null = null
  for (const segment of result.segments) {
    if (toEpochDay(segment.from) > toEpochDay(cursor)) {
      parts.push(part('GAP', cursor, addDays(segment.from, -1)))
      previous = null
    }
    const values = {
      physicalBeds: segment.physicalBeds,
      sellableCapacity: segment.sellableCapacity,
      seasonName: segment.periodId ? (result.refs.periods[segment.periodId]?.name ?? null) : null,
      deltaSellable: previous ? segment.sellableCapacity - (previous.sellableCapacity ?? 0) : null,
      deltaBeds: previous ? segment.physicalBeds - (previous.physicalBeds ?? 0) : null,
    }
    previous = part(segment.source === 'PERIOD_OVERRIDE' ? 'SEASON' : 'NORMAL', segment.from, segment.to, values)
    parts.push(previous)
    cursor = addDays(segment.to, 1)
  }
  if (toEpochDay(cursor) <= toEpochDay(result.range.to)) parts.push(part('GAP', cursor, result.range.to))
  return parts
}

/** A room a block is for, with its Haji capacity when known (the block drawer's "up to" impact figure). */
export interface BlockRoom { id: string, roomNumber: string, haji: number | null }
