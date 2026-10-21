import { describe, expect, it } from 'vitest'
import { assertBlockCreatable, blockPhase, planBlockCancellation } from '../../../../server/domain/inventory/blockRules'
import type { InventoryRuleError } from '../../../../server/domain/inventory/rules'

const TODAY = '2026-09-25'
const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as InventoryRuleError).code } return 'NO_ERROR' }

describe('operational block rules', () => {
  it('new blocks start today or later and are bounded', () => {
    expect(code(() => assertBlockCreatable(TODAY, '2026-09-30', TODAY))).toBe('NO_ERROR')
    expect(code(() => assertBlockCreatable('2026-09-24', '2026-09-30', TODAY))).toBe('BLOCK_IN_PAST')
    expect(code(() => assertBlockCreatable(TODAY, '2028-12-31', TODAY))).toBe('BLOCK_TOO_LONG')
    expect(() => assertBlockCreatable('2026-10-02', '2026-10-01', TODAY)).toThrow()
  })
  it('cancelling: unstarted -> cancel; running -> end yesterday; finished/cancelled -> conflict', () => {
    const b = (startDate: string, endDate: string, cancelledAt: Date | null = null) => ({ startDate, endDate, cancelledAt })
    expect(planBlockCancellation(b('2026-10-01', '2026-10-10'), TODAY)).toEqual({ kind: 'CANCEL' })
    expect(planBlockCancellation(b(TODAY, '2026-10-10'), TODAY)).toEqual({ kind: 'CANCEL' })
    expect(planBlockCancellation(b('2026-09-20', '2026-10-10'), TODAY)).toEqual({ kind: 'END_EARLY', newEndDate: '2026-09-24' })
    expect(planBlockCancellation(b('2026-09-20', TODAY), TODAY)).toEqual({ kind: 'END_EARLY', newEndDate: '2026-09-24' })
    expect(code(() => planBlockCancellation(b('2026-09-01', '2026-09-24'), TODAY))).toBe('BLOCK_ALREADY_ENDED')
    expect(code(() => planBlockCancellation(b('2026-10-01', '2026-10-10', new Date()), TODAY))).toBe('BLOCK_ALREADY_CANCELLED')
  })
})

describe('blockPhase (S10)', () => {
  const b = (startDate: string, endDate: string, opts: { cancelledAt?: Date | null, endedEarlyAt?: Date | null } = {}) =>
    ({ startDate, endDate, cancelledAt: opts.cancelledAt ?? null, endedEarlyAt: opts.endedEarlyAt ?? null })

  it('starts tomorrow -> UPCOMING', () => {
    expect(blockPhase(b('2026-09-26', '2026-09-30'), TODAY)).toBe('UPCOMING')
  })
  it('starts today -> RUNNING (even though planBlockCancellation still offers a full CANCEL)', () => {
    expect(blockPhase(b(TODAY, '2026-09-30'), TODAY)).toBe('RUNNING')
    expect(planBlockCancellation(b(TODAY, '2026-09-30'), TODAY)).toEqual({ kind: 'CANCEL' })
  })
  it('ends today -> RUNNING', () => {
    expect(blockPhase(b('2026-09-20', TODAY), TODAY)).toBe('RUNNING')
  })
  it('a one-night block for tonight -> RUNNING', () => {
    expect(blockPhase(b(TODAY, TODAY), TODAY)).toBe('RUNNING')
  })
  it('ended yesterday -> ENDED', () => {
    expect(blockPhase(b('2026-09-20', '2026-09-24'), TODAY)).toBe('ENDED')
  })
  it('cancelled -> CANCELLED, whatever its dates', () => {
    const at = new Date('2026-09-01T00:00:00Z')
    expect(blockPhase(b('2026-10-01', '2026-10-10', { cancelledAt: at }), TODAY)).toBe('CANCELLED')
    expect(blockPhase(b('2026-09-01', '2026-09-10', { cancelledAt: at }), TODAY)).toBe('CANCELLED')
  })
  it('ended early -> ENDED_EARLY, even though its (new) end is in the past', () => {
    expect(blockPhase(b('2026-09-20', '2026-09-24', { endedEarlyAt: new Date('2026-09-25T08:00:00Z') }), TODAY)).toBe('ENDED_EARLY')
  })
})
