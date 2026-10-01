import { MAX_BEDS_PER_ROOM, MAX_CAPACITY_PERIOD_DAYS } from '../../../shared/constants/inventory'
import { type IsoDate, addDays, makeRange, rangeLength, toEpochDay } from '../../../shared/utils/dates'
import type { CapacityValues } from './baseVersions'
import { InventoryRuleError } from './rules'

export interface PeriodDates { startDate: IsoDate, endDate: IsoDate }
export type PeriodPhase = 'FUTURE' | 'ACTIVE' | 'ENDED'

export function periodPhase(p: PeriodDates, today: IsoDate): PeriodPhase {
  if (toEpochDay(p.endDate) < toEpochDay(today)) return 'ENDED'
  if (toEpochDay(p.startDate) > toEpochDay(today)) return 'FUTURE'
  return 'ACTIVE'
}

export function assertPeriodRange(p: PeriodDates): void {
  const range = makeRange(p.startDate, p.endDate)
  if (rangeLength(range) > MAX_CAPACITY_PERIOD_DAYS) {
    throw new InventoryRuleError('PERIOD_TOO_LONG', `A capacity period cannot exceed ${MAX_CAPACITY_PERIOD_DAYS} days`, 'validation')
  }
}

export interface PeriodPatch { name?: string, notes?: string | null, kind?: string, startDate?: IsoDate, endDate?: IsoDate }

/**
 * Editing rules that keep history intact:
 * - ENDED: only name and notes.
 * - ACTIVE: start and kind are frozen; the end may be extended, or shortened down to yesterday
 *   ("end it as of today"), which only removes future nights.
 * - FUTURE: everything editable, but the start may not move into the past.
 */
export function assertPeriodPatchAllowed(period: PeriodDates & { kind: string }, patch: PeriodPatch, today: IsoDate): void {
  const phase = periodPhase(period, today)
  const touchesDates = patch.startDate !== undefined || patch.endDate !== undefined
  if (phase === 'ENDED') {
    if (touchesDates || patch.kind !== undefined) throw new InventoryRuleError('PERIOD_ENDED', 'An ended period is history: only its name and notes can change')
    return
  }
  const next = { startDate: patch.startDate ?? period.startDate, endDate: patch.endDate ?? period.endDate }
  assertPeriodRange(next)
  if (phase === 'ACTIVE') {
    if (patch.startDate !== undefined && patch.startDate !== period.startDate) throw new InventoryRuleError('PERIOD_STARTED', 'The start of a running period cannot change')
    if (patch.kind !== undefined && patch.kind !== period.kind) throw new InventoryRuleError('PERIOD_STARTED', 'The kind of a running period cannot change')
    if (toEpochDay(next.endDate) < toEpochDay(addDays(today, -1))) {
      throw new InventoryRuleError('PERIOD_END_IN_PAST', 'A running period can end at the earliest yesterday; past nights keep their configuration')
    }
    return
  }
  if (toEpochDay(next.startDate) < toEpochDay(today)) throw new InventoryRuleError('PERIOD_START_IN_PAST', 'A future period cannot be moved to start in the past')
}

export function assertOverridesChangeable(period: PeriodDates, today: IsoDate): void {
  if (periodPhase(period, today) !== 'FUTURE') {
    throw new InventoryRuleError('PERIOD_STARTED', 'Overrides can only be added or removed before a period starts; to change a running season, end it as of today and create a new period')
  }
}

export function assertPeriodDeletable(period: PeriodDates, overrideCount: number, today: IsoDate): void {
  if (periodPhase(period, today) !== 'FUTURE') throw new InventoryRuleError('PERIOD_STARTED', 'Only a period that has not started can be deleted')
  if (overrideCount > 0) throw new InventoryRuleError('PERIOD_HAS_OVERRIDES', 'Remove the period\'s room overrides first')
}

export type OverrideSpec =
  | { mode: 'ABSOLUTE', physicalBeds: number, sellableCapacity: number }
  | { mode: 'DELTA', deltaBeds: number, deltaSellable: number }

/** DELTA is applied to the room's BASE capacity on the period's first night. */
export function computeOverrideValues(spec: OverrideSpec, baseAtPeriodStart: CapacityValues): CapacityValues {
  const v = spec.mode === 'ABSOLUTE'
    ? { physicalBeds: spec.physicalBeds, sellableCapacity: spec.sellableCapacity }
    : { physicalBeds: baseAtPeriodStart.physicalBeds + spec.deltaBeds, sellableCapacity: baseAtPeriodStart.sellableCapacity + spec.deltaSellable }
  if (v.physicalBeds < 1 || v.physicalBeds > MAX_BEDS_PER_ROOM || v.sellableCapacity < 0 || v.sellableCapacity > MAX_BEDS_PER_ROOM) {
    throw new InventoryRuleError('OVERRIDE_OUT_OF_RANGE', `Resulting capacity must be 1-${MAX_BEDS_PER_ROOM} beds and 0-${MAX_BEDS_PER_ROOM} sellable`, 'validation')
  }
  return v
}
