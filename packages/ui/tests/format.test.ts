import { describe, expect, it } from 'vitest'
import { formatDate, formatMoney, formatNumber, formatStay, localeTag, nightsBetween, toHalalas, toRiyals } from '../app/utils/format'

describe('formatting (D5, §13: Gregorian dates and Western digits in both languages)', () => {
  it('dates are calendar dates: the same day whatever the time zone, Gregorian with Western digits in Arabic', () => {
    expect(formatDate('2027-06-01', 'en')).toBe('1 Jun 2027')
    expect(formatDate('2027-06-01', 'en', 'short')).toBe('1 Jun')
    const arabic = formatDate('2027-06-01', 'ar')
    expect(arabic).toMatch(/2027/)
    expect(arabic).not.toMatch(/[٠-٩]/)
    expect(localeTag('ar')).toBe('ar-SA-u-nu-latn-ca-gregory')
  })

  it('a stay is its nights: check-out is the morning they leave', () => {
    expect(nightsBetween('2027-06-01', '2027-06-04')).toBe(3)
    expect(formatStay('2027-06-01', '2027-06-04', 'en').replace(/\s/g, '')).toBe('1–4Jun2027')
  })

  it('money is halalas shown as riyals with the currency code and two decimals', () => {
    expect(formatMoney(1250000, 'en').replace(/\s/g, ' ')).toBe('SAR 12,500.00')
    expect(formatMoney(1250000, 'ar')).toMatch(/12,500\.00/)
    expect(formatMoney(1250000, 'ar')).not.toMatch(/[٠-٩]/)
  })

  it('a count is grouped by thousands, with Western digits in Arabic too', () => {
    expect(formatNumber(1490, 'en')).toBe('1,490')
    expect(formatNumber(1490, 'ar')).toMatch(/1.490/)
    expect(formatNumber(1490, 'ar')).not.toMatch(/[٠-٩]/)
  })
})

describe('an amount typed in riyals', () => {
  it('becomes whole halalas, rounded to the nearest one, and back', () => {
    expect([toHalalas(350), toHalalas(350.5), toHalalas(0.015), toHalalas(12.345)]).toEqual([35000, 35050, 2, 1235])
    expect([toRiyals(35000), toRiyals(35050), toRiyals(1)]).toEqual([350, 350.5, 0.01])
  })
})
