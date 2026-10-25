import { describe, expect, it } from 'vitest'
import { addMonths, ageGroupFor, ageOn, checkGuest, isComplete, maskPassport } from '../../../../server/domain/booking/guestRules'

const settings = { childAgeLimit: 10, infantAgeLimit: 2, passportMinValidityMonths: 6 }
const groupSlot = (ageGroup: 'ADULT' | 'CHILD' | 'INFANT', occupancy: 'MALE' | 'FEMALE' | 'FAMILY' | null) => ({ bookingType: 'GROUP' as const, ageGroup, occupancy, checkIn: '2027-06-01' })

describe('ages (v7 §7: from the date of birth on the check-in day)', () => {
  it('counts whole years; a birthday on the check-in day counts', () => {
    expect(ageOn('2017-06-01', '2027-06-01')).toBe(10)
    expect(ageOn('2017-06-02', '2027-06-01')).toBe(9)
    expect(ageOn('2016-02-29', '2027-02-28')).toBe(10)
    expect(ageOn('2016-02-29', '2027-03-01')).toBe(11)
  })

  it('CHILD under the child age, INFANT under the infant age', () => {
    expect(ageGroupFor('2017-06-02', '2027-06-01', settings)).toBe('CHILD')
    expect(ageGroupFor('2017-06-01', '2027-06-01', settings)).toBe('ADULT')
    expect(ageGroupFor('2025-06-02', '2027-06-01', settings)).toBe('INFANT')
  })

  it('adds months, clamping to the end of a shorter month', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28')
    expect(addMonths('2027-06-01', 6)).toBe('2027-12-01')
    expect(addMonths('2027-11-15', 3)).toBe('2028-02-15')
  })
})

describe('checkGuest (v7 §7, §13)', () => {
  const adult = { fullName: 'Md. Karim', gender: 'MALE' as const, dateOfBirth: '1980-01-01', passportExpiry: '2030-01-01' }

  it('in a GROUP, someone the child age or older must sleep on their own gender\'s side', () => {
    expect(checkGuest(groupSlot('ADULT', 'MALE'), adult, settings).issues).toEqual([])
    expect(checkGuest(groupSlot('ADULT', 'FEMALE'), adult, settings).issues).toEqual([{ code: 'GENDER_MISMATCH', blocking: true }])
    // A boy booked as a child on his mother's side who is 11 on check-in day counts the same; one of 8 is fine.
    expect(checkGuest(groupSlot('CHILD', 'FEMALE'), { ...adult, dateOfBirth: '2016-01-01' }, settings).issues).toEqual([{ code: 'GENDER_MISMATCH', blocking: true }])
    expect(checkGuest(groupSlot('CHILD', 'FEMALE'), { ...adult, dateOfBirth: '2019-01-01' }, settings)).toEqual({ ageGroup: 'CHILD', issues: [] })
    // FAMILY rooms have no gender rule.
    expect(checkGuest({ ...groupSlot('ADULT', 'FAMILY'), bookingType: 'FAMILY' }, { ...adult, gender: 'FEMALE' }, settings).issues).toEqual([])
  })

  it('details never cross the seat line: an infant slot for someone older, a seat for an infant; ADULT and CHILD follow the date of birth', () => {
    expect(checkGuest(groupSlot('INFANT', 'FEMALE'), { ...adult, dateOfBirth: '2022-01-01' }, settings).issues).toEqual([{ code: 'AGE_GROUP_MISMATCH', blocking: true }])
    expect(checkGuest(groupSlot('INFANT', 'FEMALE'), { ...adult, dateOfBirth: '2026-01-01' }, settings)).toEqual({ ageGroup: 'INFANT', issues: [] })
    // An adult "who is 1 year old" would leave the quota and the price: refused, the hotel changes the slot instead.
    expect(checkGuest(groupSlot('ADULT', 'MALE'), { ...adult, dateOfBirth: '2026-01-01' }, settings).issues).toEqual([{ code: 'AGE_GROUP_MISMATCH', blocking: true }])
    expect(checkGuest(groupSlot('ADULT', 'MALE'), { ...adult, dateOfBirth: '2020-01-01' }, settings)).toEqual({ ageGroup: 'CHILD', issues: [] })
  })

  it('refuses implausible dates: born after check-in or before 1900, a passport valid 20+ years', () => {
    expect(checkGuest(groupSlot('ADULT', 'MALE'), { ...adult, dateOfBirth: '2030-01-01' }, settings).issues).toEqual([{ code: 'IMPLAUSIBLE_DATE', blocking: true }])
    expect(checkGuest(groupSlot('ADULT', 'MALE'), { ...adult, dateOfBirth: '1899-12-31' }, settings).issues).toEqual([{ code: 'IMPLAUSIBLE_DATE', blocking: true }])
    expect(checkGuest(groupSlot('ADULT', 'MALE'), { ...adult, passportExpiry: '2047-06-02' }, settings).issues).toEqual([{ code: 'IMPLAUSIBLE_DATE', blocking: true }])
  })

  it('warns when the passport is valid for less than the minimum after check-in', () => {
    expect(checkGuest(groupSlot('ADULT', 'MALE'), { ...adult, passportExpiry: '2027-11-30' }, settings).issues).toEqual([{ code: 'PASSPORT_EXPIRES_SOON', blocking: false }])
    expect(checkGuest(groupSlot('ADULT', 'MALE'), { ...adult, passportExpiry: '2027-12-01' }, settings).issues).toEqual([])
  })

  it('complete only with every check-in field; lists show the last three passport characters', () => {
    expect(isComplete({ ...adult, nationality: 'BGD', passportNo: 'A1234567' })).toBe(true)
    expect(isComplete({ ...adult, nationality: 'BGD' })).toBe(false)
    expect(maskPassport('A1234567')).toBe('•••567')
    expect(maskPassport('A1234')).toBe('•••34')
  })
})
