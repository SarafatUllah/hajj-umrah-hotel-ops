import { describe, expect, it } from 'vitest'
import { dayTotals, roomNightState } from '../../../../server/domain/booking/occupancy'

const night = (over: Partial<{ sellable: boolean, capacity: number, booked: number, held: number }> = {}) => ({ sellable: true, capacity: 4, booked: 0, held: 0, ...over })

describe('roomNightState (v7 §14 legend)', () => {
  it('empty or blocked when nobody sits in it; HOLD when only holds do; full or partial otherwise', () => {
    expect(roomNightState(night())).toBe('EMPTY')
    expect(roomNightState(night({ sellable: false }))).toBe('BLOCKED')
    expect(roomNightState(night({ held: 4 }))).toBe('HELD')
    expect(roomNightState(night({ booked: 3 }))).toBe('PARTIAL')
    expect(roomNightState(night({ booked: 3, held: 1 }))).toBe('FULL')
    expect(roomNightState(night({ booked: 5 }))).toBe('FULL') // an extra bed takes it past its seats
    expect(roomNightState(night({ sellable: false, booked: 2 }))).toBe('PARTIAL') // people already in a room blocked since
  })
})

describe('dayTotals', () => {
  it('counts rooms by state and the sellable seats; the fill never passes 100%', () => {
    const totals = dayTotals([night({ booked: 4 }), night({ booked: 2, held: 1 }), night({ held: 2 }), night(), night({ sellable: false }), night({ booked: 5 })])
    expect(totals.rooms).toEqual({ total: 6, full: 2, partial: 1, held: 1, empty: 1, blocked: 1 })
    expect(totals.seats).toEqual({ total: 20, pilgrims: 11, held: 3, empty: 1 + 2 + 4 })
    expect(totals.occupancyPercent).toBe(65)
    expect(dayTotals([]).occupancyPercent).toBe(0)
  })
})
