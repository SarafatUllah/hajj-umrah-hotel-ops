import { describe, expect, it } from 'vitest'
import { planBaseChange, planReactivate, planRetire, type BaseVersionRow } from '../../../../server/domain/inventory/baseVersions'
import type { InventoryRuleError } from '../../../../server/domain/inventory/rules'

const TODAY = '2026-09-25'
const code = (fn: () => unknown) => { try { fn() } catch (e) { return (e as InventoryRuleError).code } return 'NO_ERROR' }
const open = (over: Partial<BaseVersionRow> = {}): BaseVersionRow => ({ id: 'v1', validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4, ...over })

describe('base version planning', () => {
  it('a permanent change closes the open version the day before and opens a new one', () => {
    const p = planBaseChange([open()], '2026-10-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 })
    expect(p.close).toEqual({ id: 'v1', validTo: '2026-09-30' })
    expect(p.insert).toEqual({ validFrom: '2026-10-01', validTo: null, physicalBeds: 5, sellableCapacity: 5 })
  })
  it('a change effective today is allowed, one in the past is not (history is not rewritten)', () => {
    expect(code(() => planBaseChange([open()], TODAY, TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('NO_ERROR')
    expect(code(() => planBaseChange([open()], '2026-09-24', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('BASE_CHANGE_IN_PAST')
  })
  it('the change must fall after the current version starts', () => {
    expect(code(() => planBaseChange([open({ validFrom: '2026-12-01' })], '2026-12-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('BASE_CHANGE_BEFORE_CURRENT')
  })
  it('a retired room cannot get a base change', () => {
    expect(code(() => planBaseChange([open({ validTo: '2026-12-31' })], '2027-01-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('ROOM_NOT_IN_INVENTORY')
    expect(code(() => planBaseChange([], '2027-01-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }))).toBe('ROOM_NOT_IN_INVENTORY')
  })
  it('retire closes the open version; retiring twice is rejected; past retirement is rejected', () => {
    expect(planRetire([open()], '2027-01-01', TODAY).close).toEqual({ id: 'v1', validTo: '2026-12-31' })
    expect(code(() => planRetire([open({ validTo: '2026-12-31' })], '2027-02-01', TODAY))).toBe('ROOM_ALREADY_RETIRED')
    expect(code(() => planRetire([open()], '2026-09-01', TODAY))).toBe('RETIRE_IN_PAST')
  })
  it('reactivate opens a new version after the last one, adjacent or after a gap', () => {
    const closed = open({ validTo: '2026-12-31' })
    expect(planReactivate([closed], '2027-01-01', TODAY, { physicalBeds: 4, sellableCapacity: 4 }).insert.validFrom).toBe('2027-01-01')
    expect(planReactivate([closed], '2027-06-01', TODAY, { physicalBeds: 4, sellableCapacity: 4 }).insert.validFrom).toBe('2027-06-01')
    expect(code(() => planReactivate([closed], '2026-12-31', TODAY, { physicalBeds: 4, sellableCapacity: 4 }))).toBe('REACTIVATE_BEFORE_RETIREMENT_END')
    expect(code(() => planReactivate([open()], '2027-01-01', TODAY, { physicalBeds: 4, sellableCapacity: 4 }))).toBe('ROOM_NOT_RETIRED')
  })
  it('uses the latest version even when versions are given out of order', () => {
    const versions = [open({ id: 'v2', validFrom: '2026-01-01', validTo: null }), open({ id: 'v1', validFrom: '2025-01-01', validTo: '2025-12-31' })]
    expect(planBaseChange(versions, '2026-10-01', TODAY, { physicalBeds: 5, sellableCapacity: 5 }).close.id).toBe('v2')
  })
})
