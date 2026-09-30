import { describe, expect, it } from 'vitest'
import { nextCapacityChange } from '../../../../server/domain/inventory/nextChange'
import type { BaseVersion } from '../../../../server/domain/inventory/capacity'

const ASOF = '2026-09-25'
const open = (over: Partial<BaseVersion> = {}): BaseVersion => ({ validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4, ...over })

describe('nextCapacityChange', () => {
  it('an open-ended single version -> null (no boundary at all inside the horizon)', () => {
    expect(nextCapacityChange([open()], [], ASOF)).toBeNull()
  })

  it('a base change 30 nights ahead -> CAPACITY on that night, carrying the NEW numbers', () => {
    const changeDate = '2026-10-25' // ASOF + 30
    const versions = [
      open({ validTo: '2026-10-24' }),
      open({ validFrom: changeDate, validTo: null, physicalBeds: 6, sellableCapacity: 5 }),
    ]
    const result = nextCapacityChange(versions, [], ASOF)
    expect(result).toEqual({
      kind: 'CAPACITY',
      date: changeDate,
      capacity: { physicalBeds: 6, sellableCapacity: 5, source: 'BASE', periodId: null },
    })
  })

  it('a scheduled retirement -> LEAVES_INVENTORY the day after validTo', () => {
    const versions = [open({ validTo: '2026-11-30' })]
    const result = nextCapacityChange(versions, [], ASOF)
    expect(result).toEqual({ kind: 'LEAVES_INVENTORY', date: '2026-12-01' })
  })

  it('a not-yet-commissioned room -> ENTERS_INVENTORY on its first version\'s validFrom', () => {
    const startDate = '2026-11-01'
    const versions = [open({ validFrom: startDate, validTo: null, physicalBeds: 3, sellableCapacity: 3 })]
    const result = nextCapacityChange(versions, [], ASOF)
    expect(result).toEqual({
      kind: 'ENTERS_INVENTORY',
      date: startDate,
      capacity: { physicalBeds: 3, sellableCapacity: 3, source: 'BASE', periodId: null },
    })
  })

  it('a closed-then-reopened room (gap): from before the gap -> LEAVES_INVENTORY', () => {
    const versions = [
      open({ validTo: '2026-10-10' }),
      open({ validFrom: '2026-11-01', validTo: null }), // gap: 2026-10-11 .. 2026-10-31
    ]
    const result = nextCapacityChange(versions, [], ASOF)
    expect(result).toEqual({ kind: 'LEAVES_INVENTORY', date: '2026-10-11' })
  })

  it('a closed-then-reopened room (gap): from inside the gap -> ENTERS_INVENTORY on the reopen date', () => {
    const versions = [
      open({ validTo: '2026-10-10' }),
      open({ validFrom: '2026-11-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }),
    ]
    const result = nextCapacityChange(versions, [], '2026-10-20') // inside the gap
    expect(result).toEqual({
      kind: 'ENTERS_INVENTORY',
      date: '2026-11-01',
      capacity: { physicalBeds: 4, sellableCapacity: 4, source: 'BASE', periodId: null },
    })
  })

  it('a change beyond the horizon -> null', () => {
    const versions = [open({ validTo: '2026-10-05' })] // 10 nights after ASOF (2026-09-25)
    const result = nextCapacityChange(versions, [], ASOF, 5) // horizon ends before the retirement
    expect(result).toBeNull()
  })

  it('the horizon\'s last-night boundary: a change landing exactly on the last night of the horizon is still detected', () => {
    // horizonNights=5 -> horizon covers ASOF..ASOF+4 (2026-09-25..2026-09-29). A change effective on
    // 2026-09-29 (the LAST night of the horizon) must still be reported, not silently dropped.
    const changeDate = '2026-09-29'
    const versions = [
      open({ validTo: '2026-09-28' }),
      open({ validFrom: changeDate, validTo: null, physicalBeds: 2, sellableCapacity: 2 }),
    ]
    const result = nextCapacityChange(versions, [], ASOF, 5)
    expect(result).toEqual({
      kind: 'CAPACITY',
      date: changeDate,
      capacity: { physicalBeds: 2, sellableCapacity: 2, source: 'BASE', periodId: null },
    })
  })

  it('not in inventory at all within the horizon -> null', () => {
    const versions = [open({ validFrom: '2028-01-01', validTo: null })]
    const result = nextCapacityChange(versions, [], ASOF, 30)
    expect(result).toBeNull()
  })
})
