import { type IsoDate, addDays } from '../../../shared/utils/dates'
import { MAX_CALENDAR_DAYS } from '../../../shared/constants/inventory'
import { type BaseVersion, type CapacityOverride, type CapacitySegment, type CapacitySource, capacitySegments } from './capacity'

export interface NextChangeCapacity { physicalBeds: number, sellableCapacity: number, source: CapacitySource, periodId: string | null }

export type NextChange =
  | { kind: 'CAPACITY' | 'ENTERS_INVENTORY', date: IsoDate, capacity: NextChangeCapacity }
  | { kind: 'LEAVES_INVENTORY', date: IsoDate }

function toCapacity(seg: CapacitySegment): NextChangeCapacity {
  return { physicalBeds: seg.physicalBeds, sellableCapacity: seg.sellableCapacity, source: seg.source, periodId: seg.periodId }
}

/**
 * The first change after `asOf` within `horizonNights` (default MAX_CALENDAR_DAYS), or null.
 * Built only on the verified `capacitySegments` (Task 10/11) — `capacitySegments` itself is never
 * modified here.
 *
 * If the room is in inventory on `asOf` (the first segment starts on `asOf`): no further boundary
 * inside the horizon -> null; the very next night is covered by a following segment (a change of
 * numbers, source, OR period) -> 'CAPACITY' on that night; the very next night has NO segment at all
 * (the room leaves inventory, whether or not it re-enters again later within the horizon) ->
 * 'LEAVES_INVENTORY' on that night. If the room is NOT in inventory on `asOf`: a future segment
 * exists -> 'ENTERS_INVENTORY' on its first night; none -> null.
 */
export function nextCapacityChange(versions: BaseVersion[], overrides: CapacityOverride[], asOf: IsoDate, horizonNights: number = MAX_CALENDAR_DAYS): NextChange | null {
  const end = addDays(asOf, horizonNights - 1)
  const segs = capacitySegments(versions, overrides, { from: asOf, to: end })

  const first = segs[0]
  if (first?.from === asOf) {
    if (first.to === end) return null
    const boundaryDate = addDays(first.to, 1)
    const next = segs[1]
    if (next && next.from === boundaryDate) return { kind: 'CAPACITY', date: boundaryDate, capacity: toCapacity(next) }
    return { kind: 'LEAVES_INVENTORY', date: boundaryDate }
  }

  if (!first) return null
  return { kind: 'ENTERS_INVENTORY', date: first.from, capacity: toCapacity(first) }
}
