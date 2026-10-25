import { describe, expect, it } from 'vitest'
import { barContent, bookingLabel, calendarRange, COLUMN_WIDTH, monthsOf, moveCell, nightIndexAt, placeOf, weekendColumns } from '../app/utils/calendar'

describe('the room calendar layout (§31)', () => {
  it('starts the default range yesterday, so tonight has a night of context', () => {
    expect(calendarRange({ today: '2026-10-21', from: undefined, nights: 31 })).toEqual({ from: '2026-10-20', to: '2026-11-19', nights: 31 })
    expect(calendarRange({ today: '2026-10-21', from: '2026-12-01', nights: 7 })).toEqual({ from: '2026-12-01', to: '2026-12-07', nights: 7 })
    // A mistyped link falls back to the default; before the hotel (and its today) is known there is no range yet.
    expect(calendarRange({ today: '2026-10-21', from: '2026-13-40', nights: 7 })).toEqual({ from: '2026-10-20', to: '2026-10-26', nights: 7 })
    expect(calendarRange({ today: '', from: undefined, nights: 7 })).toBeNull()
  })

  it('places a segment by its nights inside the range, clipped to it', () => {
    expect(placeOf({ from: '2026-10-22', to: '2026-10-24' }, '2026-10-20', 31)).toEqual({ column: 3, span: 3 })
    expect(placeOf({ from: '2026-10-01', to: '2026-10-21' }, '2026-10-20', 31)).toEqual({ column: 1, span: 2 })
    expect(placeOf({ from: '2026-12-01', to: '2026-12-05' }, '2026-10-20', 31)).toBeNull()
  })

  it('a bar shows what its width allows: label and capacity, the number, or nothing', () => {
    expect(barContent(1, COLUMN_WIDTH[7])).toBe('full')
    expect(barContent(1, COLUMN_WIDTH[31])).toBe('number')
    expect(barContent(1, COLUMN_WIDTH[90])).toBe('none')
    expect(barContent(3, COLUMN_WIDTH[31])).toBe('full')
  })

  it('names each month once over the columns it covers, and finds the weekend (Friday, Saturday) columns', () => {
    expect(monthsOf('2026-10-30', 4)).toEqual([{ month: '2026-10', column: 1, span: 2 }, { month: '2026-11', column: 3, span: 2 }])
    expect(weekendColumns('2026-10-21', 7)).toEqual([3, 4])
  })

  it('moves the active night with the arrow keys, mirrored when the page reads right to left', () => {
    expect(moveCell({ row: 0, night: 3 }, 'ArrowRight', { rows: 5, nights: 7, rtl: false })).toEqual({ row: 0, night: 4 })
    expect(moveCell({ row: 0, night: 3 }, 'ArrowRight', { rows: 5, nights: 7, rtl: true })).toEqual({ row: 0, night: 2 })
    expect(moveCell({ row: 4, night: 6 }, 'ArrowDown', { rows: 5, nights: 7, rtl: false })).toEqual({ row: 4, night: 6 })
    expect(moveCell({ row: 1, night: 6 }, 'End', { rows: 5, nights: 7, rtl: false })).toEqual({ row: 1, night: 6 })
    expect(moveCell({ row: 1, night: 3 }, 'Home', { rows: 5, nights: 7, rtl: false })).toEqual({ row: 1, night: 0 })
    expect(moveCell({ row: 1, night: 3 }, 'x', { rows: 5, nights: 7, rtl: false })).toBeNull()
  })
})

describe('a click on a bar', () => {
  it('falls on the night under the pointer, in reading order, and never outside the bar', () => {
    // A 10-night bar of 36px columns from x=100 to x=460.
    expect(nightIndexAt({ x: 100 + 36 * 4 + 5, left: 100, right: 460, rtl: false }, 36, 10)).toBe(4)
    expect(nightIndexAt({ x: 460 - 36 * 2 - 1, left: 100, right: 460, rtl: true }, 36, 10)).toBe(2)
    expect(nightIndexAt({ x: 470, left: 100, right: 460, rtl: false }, 36, 10)).toBe(9)
    expect(nightIndexAt({ x: 90, left: 100, right: 460, rtl: false }, 36, 10)).toBe(0)
  })
})

describe('a booked run of nights on the room calendar (UI-UX §31.2)', () => {
  const refs = { b1: { bookingNo: 'B-2027-0004' }, b2: { bookingNo: 'B-2027-0009' } }
  it('reads its booking\'s number, "+n" when more bookings share the room, nothing without one', () => {
    expect(bookingLabel({ bookingIds: ['b1'] }, refs)).toBe('B-2027-0004')
    expect(bookingLabel({ bookingIds: ['b1', 'b2'] }, refs)).toBe('B-2027-0004 +1')
    expect(bookingLabel({ bookingIds: [] }, refs)).toBeNull()
    expect(bookingLabel({ bookingIds: ['gone'] }, refs)).toBeNull()
  })
})
