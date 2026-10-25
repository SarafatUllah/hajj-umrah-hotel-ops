import { describe, expect, it } from 'vitest'
import { bookingStatusAfter, refuseMove } from '../../../../server/domain/booking/guestMoves'

const stay = { checkIn: '2027-06-01', checkOut: '2027-06-04' }

describe('refuseMove (v7 §12: each pilgrim at the desk)', () => {
  it('checks in a READY pilgrim on a day of the stay; not before, not on the departure day; full details first', () => {
    expect(refuseMove('CHECK_IN', 'READY', stay, '2027-06-01')).toBeNull()
    expect(refuseMove('CHECK_IN', 'READY', stay, '2027-06-03')).toBeNull()
    expect(refuseMove('CHECK_IN', 'READY', stay, '2027-05-31')).toBe('BEFORE_CHECK_IN')
    expect(refuseMove('CHECK_IN', 'READY', stay, '2027-06-04')).toBe('STAY_OVER')
    expect(refuseMove('CHECK_IN', 'PENDING_DETAILS', stay, '2027-06-01')).toBe('DETAILS_INCOMPLETE')
    expect(refuseMove('CHECK_IN', 'NO_SHOW', stay, '2027-06-01')).toBe('GUEST_STATUS')
  })

  it('checks out only someone checked in, any day; a no-show only from the check-in day; a repeated move is not refused', () => {
    expect(refuseMove('CHECK_OUT', 'CHECKED_IN', stay, '2027-06-02')).toBeNull()
    expect(refuseMove('CHECK_OUT', 'READY', stay, '2027-06-02')).toBe('GUEST_STATUS')
    expect(refuseMove('NO_SHOW', 'PENDING_DETAILS', stay, '2027-06-01')).toBeNull()
    expect(refuseMove('NO_SHOW', 'READY', stay, '2027-05-31')).toBe('BEFORE_CHECK_IN')
    expect(refuseMove('NO_SHOW', 'CHECKED_IN', stay, '2027-06-01')).toBe('GUEST_STATUS')
    expect(refuseMove('CHECK_IN', 'CHECKED_IN', stay, '2027-06-09')).toBeNull()
  })
})

describe('bookingStatusAfter (v7 §7)', () => {
  it('IN_HOUSE from the first arrival; COMPLETED once everyone still on the booking left or never came', () => {
    expect(bookingStatusAfter('CONFIRMED', ['READY', 'PENDING_DETAILS'])).toBe('CONFIRMED')
    expect(bookingStatusAfter('CONFIRMED', ['CHECKED_IN', 'READY'])).toBe('IN_HOUSE')
    expect(bookingStatusAfter('IN_HOUSE', ['CHECKED_OUT', 'READY'])).toBe('IN_HOUSE')
    expect(bookingStatusAfter('IN_HOUSE', ['CHECKED_OUT', 'NO_SHOW', 'REMOVED'])).toBe('COMPLETED')
    expect(bookingStatusAfter('CONFIRMED', ['NO_SHOW', 'NO_SHOW'])).toBe('COMPLETED')
    expect(bookingStatusAfter('CONFIRMED', ['REMOVED'])).toBe('CONFIRMED')
  })
})
