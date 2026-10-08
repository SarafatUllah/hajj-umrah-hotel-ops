import { describe, expect, it } from 'vitest'
import { addDays, containsDate, eachDate, intersect, isValidIsoDate, isValidTimezone, makeRange, rangeFromStay, rangeLength, rangesOverlap, todayInTimezone, toEpochDay, fromEpochDay, InvalidRangeError } from '../../../shared/utils/dates'

describe('isValidIsoDate', () => {
  it.each(['2027-05-01', '2028-02-29', '1900-01-01'])('accepts %s', d => expect(isValidIsoDate(d)).toBe(true))
  it.each(['2027-02-29', '2027-13-01', '2027-00-10', '2027-5-1', '27-05-01', '2027-05-01T00:00', '', '0099-01-01', '2027-04-31'])('rejects %s', d => expect(isValidIsoDate(d)).toBe(false))
})
describe('epoch day arithmetic', () => {
  it('round-trips', () => { expect(fromEpochDay(toEpochDay('2028-02-29'))).toBe('2028-02-29') })
  it('adds across month/year/leap boundaries', () => {
    expect(addDays('2027-07-31', 1)).toBe('2027-08-01')
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01')
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28')
  })
})
describe('ranges are inclusive on both ends', () => {
  const hajj = makeRange('2027-05-01', '2027-07-31')
  it('length counts both endpoints', () => { expect(rangeLength(hajj)).toBe(92) })
  it('contains first and last night but not the neighbours', () => {
    expect(containsDate(hajj, '2027-05-01')).toBe(true)
    expect(containsDate(hajj, '2027-07-31')).toBe(true)
    expect(containsDate(hajj, '2027-04-30')).toBe(false)
    expect(containsDate(hajj, '2027-08-01')).toBe(false)
  })
  it('adjacent ranges do not overlap; sharing one night does', () => {
    expect(rangesOverlap(makeRange('2027-05-01', '2027-05-10'), makeRange('2027-05-11', '2027-05-20'))).toBe(false)
    expect(rangesOverlap(makeRange('2027-05-01', '2027-05-10'), makeRange('2027-05-10', '2027-05-20'))).toBe(true)
  })
  it('intersects', () => {
    expect(intersect(makeRange('2027-05-01', '2027-05-10'), makeRange('2027-05-05', '2027-05-20'))).toEqual({ from: '2027-05-05', to: '2027-05-10' })
    expect(intersect(makeRange('2027-05-01', '2027-05-04'), makeRange('2027-05-05', '2027-05-20'))).toBeNull()
  })
  it('rejects reversed ranges and invalid dates', () => {
    expect(() => makeRange('2027-05-02', '2027-05-01')).toThrow(InvalidRangeError)
    expect(() => makeRange('2027-02-30', '2027-03-01')).toThrow()
  })
  it('a single-night range is valid', () => { expect(rangeLength(makeRange('2027-05-01', '2027-05-01'))).toBe(1) })
})
describe('stays', () => {
  it('a stay [checkIn, checkOut) occupies checkOut-1 as last night (same-day turnover is not a conflict)', () => {
    const s = rangeFromStay('2027-05-01', '2027-05-04')
    expect(s).toEqual({ from: '2027-05-01', to: '2027-05-03' })
    expect(rangesOverlap(s, rangeFromStay('2027-05-04', '2027-05-06'))).toBe(false)
  })
  it('rejects zero/negative length stays', () => {
    expect(() => rangeFromStay('2027-05-01', '2027-05-01')).toThrow(InvalidRangeError)
  })
})
describe('eachDate', () => {
  it('lists dates', () => { expect(eachDate(makeRange('2028-02-28', '2028-03-01'))).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']) })
  it('refuses oversized ranges (DoS guard)', () => { expect(() => eachDate(makeRange('2000-01-01', '2100-01-01'))).toThrow(InvalidRangeError) })
})
describe('hotel-local today', () => {
  it('uses the hotel timezone, not UTC', () => {
    const t = new Date('2027-05-01T22:30:00Z') // 01:30 on 2 May in Riyadh (UTC+3), still 1 May in UTC
    expect(todayInTimezone('Asia/Riyadh', t)).toBe('2027-05-02')
    expect(todayInTimezone('UTC', t)).toBe('2027-05-01')
    expect(todayInTimezone('America/Los_Angeles', t)).toBe('2027-05-01')
  })
  it('validates timezone names', () => {
    expect(isValidTimezone('Asia/Riyadh')).toBe(true)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
  })
})
