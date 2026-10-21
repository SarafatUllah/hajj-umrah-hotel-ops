import { type IsoDate, addDays, makeRange, rangeLength, toEpochDay } from '../../../shared/utils/dates'
import { InventoryRuleError } from './rules'

export const MAX_BLOCK_DAYS = 731

/** New blocks start today (hotel time) or later: history is recorded by acting on it in time, not by editing the past. */
export function assertBlockCreatable(from: IsoDate, to: IsoDate, today: IsoDate): void {
  const range = makeRange(from, to)
  if (toEpochDay(from) < toEpochDay(today)) throw new InventoryRuleError('BLOCK_IN_PAST', 'A block cannot start in the past', 'validation')
  if (rangeLength(range) > MAX_BLOCK_DAYS) throw new InventoryRuleError('BLOCK_TOO_LONG', `A block cannot exceed ${MAX_BLOCK_DAYS} days`, 'validation')
}

export type CancelAction = { kind: 'CANCEL' } | { kind: 'END_EARLY', newEndDate: IsoDate }

/**
 * - not started: soft-cancel the whole block
 * - running: end it yesterday, so nights already blocked stay blocked in the history
 * - finished or already cancelled: conflict
 */
export function planBlockCancellation(block: { startDate: IsoDate, endDate: IsoDate, cancelledAt: Date | null }, today: IsoDate): CancelAction {
  if (block.cancelledAt) throw new InventoryRuleError('BLOCK_ALREADY_CANCELLED', 'This block is already cancelled')
  if (toEpochDay(block.endDate) < toEpochDay(today)) throw new InventoryRuleError('BLOCK_ALREADY_ENDED', 'This block has already ended')
  if (toEpochDay(block.startDate) >= toEpochDay(today)) return { kind: 'CANCEL' }
  return { kind: 'END_EARLY', newEndDate: addDays(today, -1) }
}

export type BlockPhase = 'UPCOMING' | 'RUNNING' | 'ENDED' | 'CANCELLED' | 'ENDED_EARLY'
export function blockPhase(block: { startDate: IsoDate, endDate: IsoDate, cancelledAt: Date | null, endedEarlyAt: Date | null }, today: IsoDate): BlockPhase {
  if (block.cancelledAt) return 'CANCELLED'
  if (block.endedEarlyAt) return 'ENDED_EARLY'
  if (toEpochDay(block.endDate) < toEpochDay(today)) return 'ENDED'
  if (toEpochDay(block.startDate) > toEpochDay(today)) return 'UPCOMING'
  return 'RUNNING'
}
