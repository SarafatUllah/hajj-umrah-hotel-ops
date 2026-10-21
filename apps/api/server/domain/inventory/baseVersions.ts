import { type IsoDate, addDays, toEpochDay } from '../../../shared/utils/dates'
import type { BaseVersion } from './capacity'
import { InventoryRuleError } from './rules'

export interface BaseVersionRow extends BaseVersion { id: string }
export interface CapacityValues { physicalBeds: number, sellableCapacity: number }
export interface Closing { id: string, validTo: IsoDate }

function last(versions: BaseVersionRow[]): BaseVersionRow | null {
  return [...versions].sort((a, b) => toEpochDay(a.validFrom) - toEpochDay(b.validFrom)).at(-1) ?? null
}

function assertNotInPast(effectiveFrom: IsoDate, today: IsoDate, code: string) {
  if (toEpochDay(effectiveFrom) < toEpochDay(today)) {
    throw new InventoryRuleError(code, 'Changes take effect from today (hotel time) onwards; past nights are history and cannot be rewritten')
  }
}

/** A permanent base change: close the open version the day before, open a new one. History is never rewritten. */
export function planBaseChange(versions: BaseVersionRow[], effectiveFrom: IsoDate, today: IsoDate, next: CapacityValues): { close: Closing, insert: BaseVersion } {
  const current = last(versions)
  if (!current || current.validTo !== null) {
    throw new InventoryRuleError('ROOM_NOT_IN_INVENTORY', 'The room is retired (or scheduled to retire); reactivate it instead of changing its base capacity')
  }
  assertNotInPast(effectiveFrom, today, 'BASE_CHANGE_IN_PAST')
  if (toEpochDay(effectiveFrom) <= toEpochDay(current.validFrom)) {
    throw new InventoryRuleError('BASE_CHANGE_BEFORE_CURRENT', `The change must take effect after the current version starts (${current.validFrom})`)
  }
  return {
    close: { id: current.id, validTo: addDays(effectiveFrom, -1) },
    insert: { validFrom: effectiveFrom, validTo: null, physicalBeds: next.physicalBeds, sellableCapacity: next.sellableCapacity },
  }
}

/** Retiring a room = closing its open version; nights from `effectiveFrom` on are no longer in inventory. */
export function planRetire(versions: BaseVersionRow[], effectiveFrom: IsoDate, today: IsoDate): { close: Closing } {
  const current = last(versions)
  if (!current || current.validTo !== null) throw new InventoryRuleError('ROOM_ALREADY_RETIRED', 'The room is already retired')
  assertNotInPast(effectiveFrom, today, 'RETIRE_IN_PAST')
  if (toEpochDay(effectiveFrom) <= toEpochDay(current.validFrom)) {
    throw new InventoryRuleError('RETIRE_BEFORE_CURRENT', `Retirement must be after the current version starts (${current.validFrom})`)
  }
  return { close: { id: current.id, validTo: addDays(effectiveFrom, -1) } }
}

/** Reactivation opens a new open-ended version after the last closed one (a gap in between is legitimate). */
export function planReactivate(versions: BaseVersionRow[], effectiveFrom: IsoDate, today: IsoDate, next: CapacityValues): { insert: BaseVersion } {
  const current = last(versions)
  if (!current || current.validTo === null) throw new InventoryRuleError('ROOM_NOT_RETIRED', 'The room is not retired')
  assertNotInPast(effectiveFrom, today, 'REACTIVATE_IN_PAST')
  if (toEpochDay(effectiveFrom) <= toEpochDay(current.validTo)) {
    throw new InventoryRuleError('REACTIVATE_BEFORE_RETIREMENT_END', `Reactivation must be after the last in-service night (${current.validTo})`)
  }
  return { insert: { validFrom: effectiveFrom, validTo: null, physicalBeds: next.physicalBeds, sellableCapacity: next.sellableCapacity } }
}
