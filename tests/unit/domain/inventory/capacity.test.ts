import { describe, expect, it } from 'vitest'
import { capacitySegments, effectiveCapacityAt, findOverlaps, minSellableOverStay, type BaseVersion, type CapacityOverride } from '../../../../server/domain/inventory/capacity'
import { baseHotelAverage, combineAverages, dateEffectiveHotelAverage, formatRatio, makeAverage, rangeEffectiveAverage, type RoomCapacityInput } from '../../../../server/domain/inventory/averages'
import { makeRange } from '../../../../shared/utils/dates'

const base44: BaseVersion[] = [{ validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }]
const hajj2027 = (beds = 6, sellable = 6): CapacityOverride => ({ periodId: 'hajj-2027', validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: beds, sellableCapacity: sellable })

describe('Room 401 example from the requirements', () => {
  it('is 4/4 normally, 6/6 during Hajj 2027, and returns to 4/4 automatically afterwards', () => {
    const o = [hajj2027()]
    expect(effectiveCapacityAt(base44, o, '2027-04-30')).toMatchObject({ physicalBeds: 4, sellableCapacity: 4, source: 'BASE' })
    expect(effectiveCapacityAt(base44, o, '2027-05-01')).toMatchObject({ physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE', periodId: 'hajj-2027' })
    expect(effectiveCapacityAt(base44, o, '2027-07-31')).toMatchObject({ sellableCapacity: 6 })
    expect(effectiveCapacityAt(base44, o, '2027-08-01')).toMatchObject({ physicalBeds: 4, sellableCapacity: 4, source: 'BASE' })
  })
  it('does not conflate physical beds with sellable capacity', () => {
    expect(effectiveCapacityAt(base44, [hajj2027(6, 5)], '2027-06-01')).toMatchObject({ physicalBeds: 6, sellableCapacity: 5 })
  })
  it('run-length segments show the three regimes', () => {
    const segs = capacitySegments(base44, [hajj2027()], makeRange('2027-04-01', '2027-08-31'))
    expect(segs.map(s => [s.from, s.to, s.sellableCapacity, s.source])).toEqual([
      ['2027-04-01', '2027-04-30', 4, 'BASE'],
      ['2027-05-01', '2027-07-31', 6, 'PERIOD_OVERRIDE'],
      ['2027-08-01', '2027-08-31', 4, 'BASE'],
    ])
  })
  it('historical periods stay queryable after they end', () => {
    const past = { ...hajj2027(), periodId: 'hajj-2026', validFrom: '2026-05-01', validTo: '2026-07-31' }
    expect(effectiveCapacityAt(base44, [past, hajj2027()], '2026-06-15')).toMatchObject({ sellableCapacity: 6, periodId: 'hajj-2026' })
    expect(effectiveCapacityAt(base44, [past, hajj2027()], '2026-09-15')).toMatchObject({ sellableCapacity: 4, source: 'BASE' })
  })
})

describe('versioned base configuration', () => {
  const versions: BaseVersion[] = [
    { validFrom: '2025-01-01', validTo: '2026-05-31', physicalBeds: 4, sellableCapacity: 4 },
    { validFrom: '2026-06-01', validTo: null, physicalBeds: 5, sellableCapacity: 5 },
  ]
  it('a permanent base change does not rewrite history', () => {
    expect(effectiveCapacityAt(versions, [], '2026-05-31')!.sellableCapacity).toBe(4)
    expect(effectiveCapacityAt(versions, [], '2026-06-01')!.sellableCapacity).toBe(5)
  })
  it('a room is not in inventory before its first version, in a gap, or after retirement', () => {
    const gappy: BaseVersion[] = [
      { validFrom: '2025-01-01', validTo: '2026-01-31', physicalBeds: 4, sellableCapacity: 4 },
      { validFrom: '2026-03-01', validTo: '2026-12-31', physicalBeds: 4, sellableCapacity: 4 },
    ]
    expect(effectiveCapacityAt(gappy, [], '2024-12-31')).toBeNull()
    expect(effectiveCapacityAt(gappy, [], '2026-02-15')).toBeNull()
    expect(effectiveCapacityAt(gappy, [], '2027-01-01')).toBeNull()
  })
  it('an override on a night without a base version is ignored (room not in inventory)', () => {
    expect(effectiveCapacityAt([], [hajj2027()], '2027-06-01')).toBeNull()
  })
  it('segments skip nights not in inventory', () => {
    const gappy: BaseVersion[] = [{ validFrom: '2027-05-10', validTo: '2027-05-20', physicalBeds: 3, sellableCapacity: 3 }]
    expect(capacitySegments(gappy, [], makeRange('2027-05-01', '2027-05-31'))).toEqual([
      { from: '2027-05-10', to: '2027-05-20', physicalBeds: 3, sellableCapacity: 3, source: 'BASE', periodId: null },
    ])
  })
})

describe('minSellableOverStay (a stay spanning a capacity boundary)', () => {
  it('uses the minimum across all nights', () => {
    expect(minSellableOverStay(base44, [hajj2027()], makeRange('2027-04-29', '2027-05-03'))).toBe(4)
    expect(minSellableOverStay(base44, [hajj2027()], makeRange('2027-05-02', '2027-05-05'))).toBe(6)
  })
  it('is null when any night is outside inventory', () => {
    expect(minSellableOverStay([{ ...base44[0]!, validFrom: '2027-05-03' }], [], makeRange('2027-05-01', '2027-05-05'))).toBeNull()
  })
})

describe('findOverlaps', () => {
  it('finds overlapping ranges and treats adjacent ranges as fine', () => {
    expect(findOverlaps([makeRange('2027-01-01', '2027-01-10'), makeRange('2027-01-11', '2027-01-20')])).toEqual([])
    expect(findOverlaps([makeRange('2027-01-01', '2027-01-10'), makeRange('2027-01-10', '2027-01-20')])).toHaveLength(1)
  })
})

function hotel(spec: Array<[count: number, beds: number]>, overridden: number, upliftTo?: number): RoomCapacityInput[] {
  const rooms: RoomCapacityInput[] = []
  let idx = 0
  for (const [count, beds] of spec) {
    for (let i = 0; i < count; i++) {
      const versions: BaseVersion[] = [{ validFrom: '2025-01-01', validTo: null, physicalBeds: beds, sellableCapacity: beds }]
      const overrides: CapacityOverride[] = idx < overridden && upliftTo ? [hajj2027(upliftTo, upliftTo)] : []
      rooms.push({ roomId: `r${idx++}`, versions, overrides })
    }
  }
  return rooms
}

describe('automatic hotel averages', () => {
  // 25 triples + 40 quads + 15 quints = 80 rooms, capacity 75 + 160 + 75 = 310
  const ajyad = hotel([[25, 3], [40, 4], [15, 5]], 0)
  it('310 capacity over 80 rooms is 3.875 and displays as 3.88 (half-up)', () => {
    const r = baseHotelAverage(ajyad, '2026-10-01')
    expect(r).toMatchObject({ numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' })
  })
  it('the date-effective average follows seasonal overrides and reverts after the period', () => {
    const rooms = hotel([[25, 3], [40, 4], [15, 5]], 30, 6) // 30 rooms go to 6 during Hajj
    // first 25 rooms are triples (3->6 = +3 each), next 5 are quads (4->6 = +2 each): +75 +10
    expect(dateEffectiveHotelAverage(rooms, '2027-06-01')).toMatchObject({ numerator: 310 + 75 + 10, denominator: 80 })
    expect(baseHotelAverage(rooms, '2027-06-01').numerator).toBe(310)
    expect(dateEffectiveHotelAverage(rooms, '2027-08-01').numerator).toBe(310)
  })
  it('a hotel with no rooms in inventory has an undefined average, not 0 or NaN', () => {
    expect(baseHotelAverage([], '2026-10-01')).toMatchObject({ value: null, display: null, denominator: 0 })
    expect(dateEffectiveHotelAverage(ajyad, '2020-01-01')).toMatchObject({ value: null, display: null })
  })
  it('range average is weighted by room-nights (straddling the period boundary)', () => {
    const rooms = hotel([[2, 4]], 2, 6)
    // nights Jul 30, 31 at 6, Aug 1, 2 at 4, for both rooms: (6+6+4+4)*2 / (4*2)
    const r = rangeEffectiveAverage(rooms, makeRange('2027-07-30', '2027-08-02'))
    expect(r).toMatchObject({ numerator: 40, denominator: 8, value: 5, basis: 'ROOM_NIGHTS' })
  })
  it('rooms that join mid-range only count for their own nights', () => {
    const rooms: RoomCapacityInput[] = [
      { roomId: 'a', versions: [{ validFrom: '2027-05-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }], overrides: [] },
      { roomId: 'b', versions: [{ validFrom: '2027-05-03', validTo: null, physicalBeds: 6, sellableCapacity: 6 }], overrides: [] },
    ]
    expect(rangeEffectiveAverage(rooms, makeRange('2027-05-01', '2027-05-04'))).toMatchObject({ numerator: 4 * 4 + 6 * 2, denominator: 6 })
  })
  it('all-hotel average is weighted, never an average of averages', () => {
    const small = makeAverage(3, 1, 'ROOMS') // 1 room of 3
    const big = makeAverage(400, 100, 'ROOMS') // 100 rooms of 4
    expect(combineAverages([small, big])).toMatchObject({ numerator: 403, denominator: 101 })
    expect(combineAverages([small, big]).value).not.toBeCloseTo((3 + 4) / 2)
    expect(combineAverages([])).toMatchObject({ value: null })
  })
  it('refuses to mix room and room-night bases', () => {
    expect(() => combineAverages([makeAverage(1, 1, 'ROOMS'), makeAverage(1, 1, 'ROOM_NIGHTS')])).toThrow()
  })
})

describe('formatRatio', () => {
  it.each([[310, 80, '3.88'], [1, 3, '0.33'], [2, 3, '0.67'], [5, 2, '2.50'], [0, 5, '0.00'], [1, 8, '0.13'], [3, 8, '0.38']])('%i/%i -> %s', (n, d, s) => expect(formatRatio(n, d)).toBe(s))
  it('returns null for a zero denominator', () => expect(formatRatio(5, 0)).toBeNull())
})
