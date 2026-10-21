import { describe, expect, it } from 'vitest'
import { effectiveBookingStatus, receiptLines } from '../../../../server/domain/booking/bookingView'

describe('effectiveBookingStatus', () => {
  const now = new Date('2027-05-01T10:00:00Z')

  it('a pending booking past its hold reads EXPIRED; anything else is as stored', () => {
    expect(effectiveBookingStatus({ status: 'HELD', holdExpiresAt: new Date('2027-05-01T10:00:00Z') }, now)).toBe('EXPIRED')
    expect(effectiveBookingStatus({ status: 'REQUESTED', holdExpiresAt: new Date('2027-05-01T10:00:01Z') }, now)).toBe('REQUESTED')
    expect(effectiveBookingStatus({ status: 'CONFIRMED', holdExpiresAt: null }, now)).toBe('CONFIRMED')
  })
})

describe('receiptLines (v7 §11: extra beds on their own line)', () => {
  it('sums the nights of the same kind, room type, quantity and price; a season change starts a new line', () => {
    const night = (n: string, kind: 'PERSON' | 'EXTRA_BED', unit: number, quantity = 4) => ({ night: n, kind, roomTypeId: 'quad', quantity, unitAmountHalalas: unit, amountHalalas: quantity * unit, vatIncluded: true })
    expect(receiptLines([night('2027-06-29', 'PERSON', 35000), night('2027-06-29', 'EXTRA_BED', 8000, 1), night('2027-06-30', 'PERSON', 35000), night('2027-07-01', 'PERSON', 30000)])).toEqual([
      { kind: 'PERSON', roomTypeId: 'quad', quantity: 4, unitAmountHalalas: 35000, nights: 2, amountHalalas: 280000, vatIncluded: true },
      { kind: 'EXTRA_BED', roomTypeId: 'quad', quantity: 1, unitAmountHalalas: 8000, nights: 1, amountHalalas: 8000, vatIncluded: true },
      { kind: 'PERSON', roomTypeId: 'quad', quantity: 4, unitAmountHalalas: 30000, nights: 1, amountHalalas: 120000, vatIncluded: true },
    ])
  })
})
