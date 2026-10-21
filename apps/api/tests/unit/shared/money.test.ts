import { describe, expect, it } from 'vitest'
import { MAX_BOOKING_PILGRIMS, MAX_BOOKING_ROOMS } from '@hajj/contracts/schemas/booking'
import { halalas, MAX_UNIT_HALALAS } from '@hajj/contracts/schemas/bookingRules'
import { toHalalas, toRiyals } from '@hajj/contracts/utils/money'

describe('money in riyals and halalas', () => {
  it('riyals become whole halalas, rounded to the nearest one, and back', () => {
    expect([toHalalas(350), toHalalas(350.5), toHalalas(0.015), toHalalas(12.345)]).toEqual([35000, 35050, 2, 1235])
    expect([toRiyals(35000), toRiyals(35050), toRiyals(1)]).toEqual([350, 350.5, 0.01])
  })
})

describe('a unit price (per person, room or bed, a night)', () => {
  it('is bounded so that a night\'s price line — its most pilgrims or extra beds times the unit — fits the 32-bit amount column', () => {
    const MAX_EXTRA_BEDS_PER_ROOM = 5
    const mostOnOneLine = Math.max(MAX_BOOKING_PILGRIMS, MAX_BOOKING_ROOMS * MAX_EXTRA_BEDS_PER_ROOM)
    expect(MAX_UNIT_HALALAS * mostOnOneLine).toBeLessThan(2 ** 31)
    expect(halalas.safeParse(MAX_UNIT_HALALAS).success).toBe(true)
    expect(halalas.safeParse(MAX_UNIT_HALALAS + 1).success).toBe(false)
  })
})

