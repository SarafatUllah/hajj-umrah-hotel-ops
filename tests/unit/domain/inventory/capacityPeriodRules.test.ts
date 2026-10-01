import { describe, expect, it } from 'vitest'
import { assertOverridesChangeable, assertPeriodDeletable, assertPeriodPatchAllowed, assertPeriodRange, computeOverrideValues, periodPhase } from '../../../../server/domain/inventory/capacityPeriodRules'
import type { InventoryRuleError } from '../../../../server/domain/inventory/rules'

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for parity with the brief's verified block (copied verbatim); not referenced by any case below.
const TODAY = '2026-09-25'
const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as InventoryRuleError).code } return 'NO_ERROR' }

describe('capacity period rules', () => {
  const hajj = { startDate: '2027-05-01', endDate: '2027-07-31', kind: 'HAJJ' }
  it('phases follow hotel-local today with inclusive boundaries', () => {
    expect(periodPhase(hajj, '2027-04-30')).toBe('FUTURE')
    expect(periodPhase(hajj, '2027-05-01')).toBe('ACTIVE')
    expect(periodPhase(hajj, '2027-07-31')).toBe('ACTIVE')
    expect(periodPhase(hajj, '2027-08-01')).toBe('ENDED')
  })
  it('range and length: 366 days is the cap (a leap year fits, 367 does not)', () => {
    expect(code(() => assertPeriodRange({ startDate: '2028-01-01', endDate: '2028-12-31' }))).toBe('NO_ERROR')
    expect(code(() => assertPeriodRange({ startDate: '2028-01-01', endDate: '2029-01-01' }))).toBe('PERIOD_TOO_LONG')
    expect(() => assertPeriodRange({ startDate: '2027-02-01', endDate: '2027-01-01' })).toThrow()
  })
  it('an ENDED period only accepts name/notes', () => {
    expect(code(() => assertPeriodPatchAllowed(hajj, { name: 'Hajj 1448' }, '2027-09-01'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-08-15' }, '2027-09-01'))).toBe('PERIOD_ENDED')
    expect(code(() => assertPeriodPatchAllowed(hajj, { kind: 'SPECIAL' }, '2027-09-01'))).toBe('PERIOD_ENDED')
  })
  it('an ACTIVE period keeps its start/kind; its end can be extended or cut to yesterday, not into the past', () => {
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-08-10' }, '2027-06-15'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-06-14' }, '2027-06-15'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { endDate: '2027-06-13' }, '2027-06-15'))).toBe('PERIOD_END_IN_PAST')
    expect(code(() => assertPeriodPatchAllowed(hajj, { startDate: '2027-05-02' }, '2027-06-15'))).toBe('PERIOD_STARTED')
    expect(code(() => assertPeriodPatchAllowed(hajj, { kind: 'SPECIAL' }, '2027-06-15'))).toBe('PERIOD_STARTED')
  })
  it('a FUTURE period is fully editable but cannot move into the past', () => {
    expect(code(() => assertPeriodPatchAllowed(hajj, { startDate: '2027-04-20', endDate: '2027-08-20', kind: 'SPECIAL' }, '2027-03-01'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodPatchAllowed(hajj, { startDate: '2027-02-01' }, '2027-03-01'))).toBe('PERIOD_START_IN_PAST')
  })
  it('overrides may only change, and periods only be deleted, before they start (and empty)', () => {
    expect(code(() => assertOverridesChangeable(hajj, '2027-04-30'))).toBe('NO_ERROR')
    expect(code(() => assertOverridesChangeable(hajj, '2027-05-01'))).toBe('PERIOD_STARTED')
    expect(code(() => assertPeriodDeletable(hajj, 0, '2027-04-30'))).toBe('NO_ERROR')
    expect(code(() => assertPeriodDeletable(hajj, 3, '2027-04-30'))).toBe('PERIOD_HAS_OVERRIDES')
    expect(code(() => assertPeriodDeletable(hajj, 0, '2027-05-01'))).toBe('PERIOD_STARTED')
  })
  it('ABSOLUTE and DELTA override values, with range validation', () => {
    const base = { physicalBeds: 4, sellableCapacity: 4 }
    expect(computeOverrideValues({ mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, base)).toEqual({ physicalBeds: 6, sellableCapacity: 6 })
    expect(computeOverrideValues({ mode: 'DELTA', deltaBeds: 2, deltaSellable: 2 }, base)).toEqual({ physicalBeds: 6, sellableCapacity: 6 })
    expect(computeOverrideValues({ mode: 'DELTA', deltaBeds: 2, deltaSellable: 1 }, base)).toEqual({ physicalBeds: 6, sellableCapacity: 5 })
    expect(code(() => computeOverrideValues({ mode: 'DELTA', deltaBeds: -4, deltaSellable: 0 }, base))).toBe('OVERRIDE_OUT_OF_RANGE')
    expect(code(() => computeOverrideValues({ mode: 'ABSOLUTE', physicalBeds: 31, sellableCapacity: 5 }, base))).toBe('OVERRIDE_OUT_OF_RANGE')
    expect(code(() => computeOverrideValues({ mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: -1 }, base))).toBe('OVERRIDE_OUT_OF_RANGE')
  })
})
