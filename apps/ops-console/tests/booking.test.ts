import { describe, expect, it } from 'vitest'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { bookingActionsOf, bookingChangeKeys, guestActionsOf } from '../app/utils/booking'

const allowed = (...permissions: Permission[]) => (p: Permission) => permissions.includes(p)
const everything = allowed('booking.create', 'booking.edit', 'booking.cancel', 'booking.checkIn')
const stay = { checkIn: '2027-06-01', checkOut: '2027-06-04', pilgrims: 4 }

describe('what staff are offered on a booking (v7 §7, §12)', () => {
  it('a pending booking can be confirmed, cancelled, changed and given pilgrims; no receipt yet', () => {
    expect(bookingActionsOf({ status: 'HELD', ...stay }, [{ status: 'PENDING_DETAILS' }], everything, true))
      .toEqual({ confirm: true, cancel: true, changeDates: true, addPilgrims: true, editDetails: true, scans: true, receipt: false })
  })

  it('once a pilgrim has arrived the dates stay, and an in-house booking is checked out rather than cancelled', () => {
    const inHouse = bookingActionsOf({ status: 'IN_HOUSE', ...stay }, [{ status: 'CHECKED_IN' }, { status: 'READY' }], everything, true)
    expect(inHouse).toMatchObject({ confirm: false, cancel: false, changeDates: false, addPilgrims: false, editDetails: true, receipt: true })
    const arrived = bookingActionsOf({ status: 'CONFIRMED', ...stay }, [{ status: 'CHECKED_IN' }], everything, true)
    expect(arrived.changeDates).toBe(false)
  })

  it('a closed booking offers only its receipt when it was confirmed', () => {
    expect(bookingActionsOf({ status: 'COMPLETED', ...stay }, [], everything, true)).toEqual({ confirm: false, cancel: false, changeDates: false, addPilgrims: false, editDetails: false, scans: false, receipt: true })
    expect(Object.values(bookingActionsOf({ status: 'EXPIRED', ...stay }, [], everything, true)).some(Boolean)).toBe(false)
  })

  it('at an inactive hotel only the booking can be cancelled; before its pilgrims are known the dates stay', () => {
    expect(bookingActionsOf({ status: 'CONFIRMED', ...stay }, [{ status: 'READY' }], everything, false))
      .toEqual({ confirm: false, cancel: true, changeDates: false, addPilgrims: false, editDetails: false, scans: false, receipt: true })
    expect(guestActionsOf({ status: 'READY', roomNumber: '101' }, { status: 'CONFIRMED', ...stay }, '2027-06-01', everything, false))
      .toEqual({ checkIn: false, checkOut: false, noShow: false, remove: false, move: false, detailsNeeded: false })
    expect(bookingActionsOf({ status: 'HELD', ...stay }, null, everything, true).changeDates).toBe(false)
  })

  it('each action needs its permission', () => {
    expect(bookingActionsOf({ status: 'HELD', ...stay }, [], allowed('booking.edit'), true)).toMatchObject({ confirm: false, cancel: false, changeDates: true })
  })
})

describe('what staff are offered on a pilgrim at the desk', () => {
  const confirmed = { status: 'CONFIRMED' as const, ...stay }

  it('checks in a pilgrim with full details on a night of the stay; one without details is reported, not offered', () => {
    expect(guestActionsOf({ status: 'READY', roomNumber: '101' }, confirmed, '2027-06-01', everything, true)).toMatchObject({ checkIn: true, noShow: true, detailsNeeded: false })
    expect(guestActionsOf({ status: 'PENDING_DETAILS', roomNumber: '101' }, confirmed, '2027-06-02', everything, true)).toMatchObject({ checkIn: false, noShow: true, detailsNeeded: true })
    expect(guestActionsOf({ status: 'READY', roomNumber: '101' }, confirmed, '2027-05-31', everything, true)).toMatchObject({ checkIn: false, noShow: false })
    expect(guestActionsOf({ status: 'READY', roomNumber: '101' }, confirmed, '2027-06-04', everything, true).checkIn).toBe(false)
  })

  it('checks out an arrived pilgrim on any day, and moves or removes only those still to come', () => {
    const arrived = guestActionsOf({ status: 'CHECKED_IN', roomNumber: '101' }, { ...confirmed, status: 'IN_HOUSE' }, '2027-06-02', everything, true)
    expect(arrived).toMatchObject({ checkOut: true, checkIn: false, remove: false, move: true })
    expect(guestActionsOf({ status: 'READY', roomNumber: '101' }, { ...confirmed, status: 'HELD' }, '2027-05-20', everything, true)).toMatchObject({ checkIn: false, remove: true, move: true })
    expect(Object.values(guestActionsOf({ status: 'NO_SHOW', roomNumber: '101' }, confirmed, '2027-06-02', everything, true)).some(Boolean)).toBe(false)
  })

  it('never removes the last pilgrim (the booking is cancelled instead)', () => {
    expect(guestActionsOf({ status: 'READY', roomNumber: '101' }, { ...confirmed, pilgrims: 1 }, '2027-05-20', everything, true).remove).toBe(false)
  })

  it('nothing moves after the stay or without the desk permission', () => {
    expect(guestActionsOf({ status: 'CHECKED_IN', roomNumber: '101' }, confirmed, '2027-06-04', everything, true).move).toBe(false)
    expect(guestActionsOf({ status: 'READY', roomNumber: '101' }, confirmed, '2027-06-01', allowed('booking.edit'), true)).toMatchObject({ checkIn: false, noShow: false, move: true })
  })
})

describe('what a booking\'s change shows in', () => {
  it('every screen that reads bookings, and the booking\'s own page when named', () => {
    expect(bookingChangeKeys()).toEqual([['bookings'], ['occupancy'], ['occupancy-day'], ['tasks'], ['quotes'], ['quote']])
    expect(bookingChangeKeys('b1').slice(0, 3)).toEqual([['booking', 'b1'], ['booking-guests', 'b1'], ['booking-receipt', 'b1']])
  })
})
