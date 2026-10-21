import { describe, expect, it } from 'vitest'
import { availableStayAverage, buildRoomSegments, matchesCapacityFilter, matchesStatusFilter, summarizeDaily, type RoomCalendarInput } from '../../../../server/domain/inventory/calendar'
import { makeRange } from '../../../../shared/utils/dates'

const opts = { maintenanceBlocksSales: true }
const room = (over: Partial<RoomCalendarInput> = {}): RoomCalendarInput => ({
  roomId: 'r401',
  versions: [{ validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 }],
  overrides: [],
  blocks: [],
  ...over,
})
const brief = (segs: ReturnType<typeof buildRoomSegments>) => segs.map(s => `${s.from}..${s.to} ${s.status}${s.sellable ? '' : '!'} ${s.sellableCapacity}`)

describe('buildRoomSegments', () => {
  it('a plain room is one AVAILABLE segment', () => {
    expect(brief(buildRoomSegments(room(), makeRange('2027-06-01', '2027-06-10'), opts))).toEqual(['2027-06-01..2027-06-10 AVAILABLE 4'])
  })
  it('separates capacity regime and operational states as independent layers', () => {
    const r = room({
      overrides: [{ periodId: 'h', validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: 6, sellableCapacity: 6 }],
      blocks: [{ id: 'b1', kind: 'MAINTENANCE', from: '2027-05-10', to: '2027-05-12' }],
    })
    expect(brief(buildRoomSegments(r, makeRange('2027-04-29', '2027-05-14'), opts))).toEqual([
      '2027-04-29..2027-04-30 AVAILABLE 4',
      '2027-05-01..2027-05-09 AVAILABLE 6',
      '2027-05-10..2027-05-12 MAINTENANCE! 6',
      '2027-05-13..2027-05-14 AVAILABLE 6',
    ])
  })
  it('out of service outranks maintenance outranks operational block on overlapping nights', () => {
    const r = room({ blocks: [
      { id: 'a', kind: 'OPERATIONAL_BLOCK', from: '2027-06-01', to: '2027-06-10' },
      { id: 'b', kind: 'MAINTENANCE', from: '2027-06-03', to: '2027-06-06' },
      { id: 'c', kind: 'OUT_OF_SERVICE', from: '2027-06-05', to: '2027-06-05' },
    ] })
    expect(brief(buildRoomSegments(r, makeRange('2027-06-01', '2027-06-10'), opts))).toEqual([
      '2027-06-01..2027-06-02 OPERATIONAL_BLOCK! 4',
      '2027-06-03..2027-06-04 MAINTENANCE! 4',
      '2027-06-05..2027-06-05 OUT_OF_SERVICE! 4',
      '2027-06-06..2027-06-06 MAINTENANCE! 4',
      '2027-06-07..2027-06-10 OPERATIONAL_BLOCK! 4',
    ])
  })
  it('nights outside inventory are NOT_IN_INVENTORY and ignore blocks', () => {
    const r = room({ versions: [{ validFrom: '2027-06-05', validTo: '2027-06-08', physicalBeds: 4, sellableCapacity: 4 }], blocks: [{ id: 'x', kind: 'OUT_OF_SERVICE', from: '2027-06-01', to: '2027-06-30' }] })
    expect(brief(buildRoomSegments(r, makeRange('2027-06-03', '2027-06-10'), opts))).toEqual([
      '2027-06-03..2027-06-04 NOT_IN_INVENTORY! null',
      '2027-06-05..2027-06-08 OUT_OF_SERVICE! 4',
      '2027-06-09..2027-06-10 NOT_IN_INVENTORY! null',
    ])
  })
  it('honours the maintenanceBlocksSales hotel setting (shown as maintenance, still sellable)', () => {
    const r = room({ blocks: [{ id: 'm', kind: 'MAINTENANCE', from: '2027-06-01', to: '2027-06-02' }] })
    const segs = buildRoomSegments(r, makeRange('2027-06-01', '2027-06-03'), { maintenanceBlocksSales: false })
    expect(segs[0]).toMatchObject({ status: 'MAINTENANCE', sellable: true })
  })
  it('a maintenance block that does not block sales still cannot hide an operational block', () => {
    const r = room({ blocks: [
      { id: 'm', kind: 'MAINTENANCE', from: '2027-06-01', to: '2027-06-02' },
      { id: 'o', kind: 'OPERATIONAL_BLOCK', from: '2027-06-01', to: '2027-06-02' },
    ] })
    expect(buildRoomSegments(r, makeRange('2027-06-01', '2027-06-02'), { maintenanceBlocksSales: false })[0]).toMatchObject({ status: 'MAINTENANCE', sellable: false })
  })
  it('segments always cover the requested range exactly, without gaps or overlaps', () => {
    const r = room({ blocks: [{ id: 'b', kind: 'MAINTENANCE', from: '2027-06-03', to: '2027-06-04' }] })
    const segs = buildRoomSegments(r, makeRange('2027-06-01', '2027-06-07'), opts)
    expect(segs[0]!.from).toBe('2027-06-01')
    expect(segs.at(-1)!.to).toBe('2027-06-07')
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.from > segs[i - 1]!.to).toBe(true)
  })
  it('a single-night range works and leap day is respected', () => {
    expect(buildRoomSegments(room(), makeRange('2028-02-29', '2028-02-29'), opts)).toHaveLength(1)
  })
})

describe('summarizeDaily', () => {
  it('counts rooms per status and capacity per day', () => {
    const rooms = [
      room({ roomId: 'a' }),
      room({ roomId: 'b', blocks: [{ id: 'k', kind: 'OUT_OF_SERVICE', from: '2027-06-02', to: '2027-06-02' }] }),
      room({ roomId: 'c', versions: [{ validFrom: '2027-06-02', validTo: null, physicalBeds: 6, sellableCapacity: 6 }] }),
    ]
    const rows = summarizeDaily(rooms, makeRange('2027-06-01', '2027-06-02'), opts)
    expect(rows[0]).toMatchObject({ date: '2027-06-01', roomsInInventory: 2, sellableRooms: 2, outOfService: 0, effectiveSellableCapacity: 8, sellableRoomCapacity: 8 })
    expect(rows[1]).toMatchObject({ date: '2027-06-02', roomsInInventory: 3, sellableRooms: 2, outOfService: 1, effectiveSellableCapacity: 14, sellableRoomCapacity: 10 })
  })
  it('an empty hotel yields zero rows of data, not errors', () => {
    expect(summarizeDaily([], makeRange('2027-06-01', '2027-06-02'), opts).every(r => r.roomsInInventory === 0)).toBe(true)
  })
})

describe('filters', () => {
  const segs = buildRoomSegments(room({ blocks: [{ id: 'm', kind: 'MAINTENANCE', from: '2027-06-03', to: '2027-06-04' }] }), makeRange('2027-06-01', '2027-06-07'), opts)
  it('any vs all semantics', () => {
    expect(matchesStatusFilter(segs, ['MAINTENANCE'], 'any')).toBe(true)
    expect(matchesStatusFilter(segs, ['MAINTENANCE'], 'all')).toBe(false)
    expect(matchesStatusFilter(segs, ['MAINTENANCE', 'AVAILABLE'], 'all')).toBe(true)
    expect(matchesStatusFilter(segs, [], 'all')).toBe(true)
  })
  it('capacity filter', () => {
    expect(matchesCapacityFilter(segs, 4, 4)).toBe(true)
    expect(matchesCapacityFilter(segs, 5)).toBe(false)
    expect(matchesCapacityFilter(segs)).toBe(true)
  })
})

describe('availableStayAverage', () => {
  const rooms = [
    room({ roomId: 'a' }),
    room({ roomId: 'b', overrides: [{ periodId: 'h', validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: 6, sellableCapacity: 6 }] }),
    room({ roomId: 'c', blocks: [{ id: 'k', kind: 'OUT_OF_SERVICE', from: '2027-05-03', to: '2027-05-03' }] }),
  ]
  it('excludes rooms blocked on any night and uses the minimum capacity across the stay', () => {
    const r = availableStayAverage(rooms, makeRange('2027-04-29', '2027-05-04'), opts) // b: min(4,4,6,6,..)=4 ; c blocked
    expect(r.eligibleRoomIds).toEqual(['a', 'b'])
    expect(r).toMatchObject({ numerator: 8, denominator: 2, value: 4, display: '4.00' })
  })
  it('a stay wholly inside Hajj sees the seasonal capacity', () => {
    const r = availableStayAverage(rooms, makeRange('2027-06-01', '2027-06-03'), opts)
    expect(r).toMatchObject({ numerator: 4 + 6 + 4, denominator: 3 })
  })
  it('no eligible rooms gives an undefined average', () => {
    expect(availableStayAverage(rooms, makeRange('2027-05-03', '2027-05-03'), { maintenanceBlocksSales: true }).eligibleRoomIds).toEqual(['a', 'b'])
    expect(availableStayAverage([], makeRange('2027-05-03', '2027-05-03'), opts)).toMatchObject({ value: null, display: null })
  })
})
