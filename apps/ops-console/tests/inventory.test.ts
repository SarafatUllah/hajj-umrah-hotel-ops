import { describe, expect, it } from 'vitest'
import type { CapacityTimelineResult } from '@hajj/contracts/types/inventory'
import { roomNumberPreview, signed, timelineOf } from '../app/utils/inventory'

describe('the bulk rooms preview (§27)', () => {
  it('a range gives its numbers as the API will store them', () => {
    expect(roomNumberPreview({ mode: 'range', prefix: '4', from: 1, to: 3, pad: 2, list: '' })).toEqual({ numbers: ['401', '402', '403'], invalid: [], duplicates: [], requested: 3 })
  })

  it('a range larger than one creation allows is counted, not built (a typo of 50000 must not freeze the page)', () => {
    const preview = roomNumberPreview({ mode: 'range', prefix: '', from: 1, to: 999_999, pad: 0, list: '' })
    expect(preview).toEqual({ numbers: [], invalid: [], duplicates: [], requested: 999_999 })
  })

  it('a pasted list is normalized (Arabic digits, case), with the invalid and repeated ones named', () => {
    const preview = roomNumberPreview({ mode: 'list', prefix: '', from: 0, to: 0, pad: 0, list: '٤٠١\n402\n\n 402 \n-bad\nb12' })
    expect(preview).toEqual({ numbers: ['401', '402', 'B12'], invalid: ['-bad'], duplicates: ['402'], requested: 5 })
  })
})

describe('the capacity timeline (§29)', () => {
  const result: CapacityTimelineResult = {
    range: { from: '2027-04-01', to: '2027-08-31' },
    meta: { today: '2027-04-10' },
    segments: [
      { from: '2027-04-01', to: '2027-04-30', physicalBeds: 4, sellableCapacity: 4, source: 'BASE', periodId: null },
      { from: '2027-05-01', to: '2027-07-31', physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE', periodId: 'p1' },
      { from: '2027-08-01', to: '2027-08-20', physicalBeds: 4, sellableCapacity: 4, source: 'BASE', periodId: null },
    ],
    refs: { periods: { p1: { id: 'p1', name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' } } },
  }

  it('names each part (normal or the season), its change from the part before, and a gap as out of inventory', () => {
    const parts = timelineOf(result)
    expect(parts.map(p => [p.kind, p.from, p.to, p.seasonName, p.deltaSellable])).toEqual([
      ['NORMAL', '2027-04-01', '2027-04-30', null, null],
      ['SEASON', '2027-05-01', '2027-07-31', 'Hajj 2027', 2],
      ['NORMAL', '2027-08-01', '2027-08-20', null, -2],
      ['GAP', '2027-08-21', '2027-08-31', null, null],
    ])
    expect(parts[0]).toMatchObject({ nights: 30, past: false, current: true })
  })
})

describe('a capacity change as shown', () => {
  it('always carries its sign, and zero has none', () => {
    expect([signed(2), signed(-1), signed(0)]).toEqual(['+2', '-1', '0'])
  })
})
