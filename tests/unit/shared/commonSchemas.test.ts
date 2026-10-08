import { describe, expect, it } from 'vitest'
import { dateRange, isoDate, pagination, safeText, uniqueIds, uuid } from '../../../shared/schemas/common'
import { MAX_CALENDAR_DAYS } from '../../../shared/constants/inventory'

describe('uuid', () => {
  it('accepts a valid uuid and rejects garbage', () => {
    expect(uuid.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true)
    expect(uuid.safeParse('not-a-uuid').success).toBe(false)
  })
})

describe('isoDate', () => {
  it.each(['2027-2-30', '2027-02-30', '', '2027-05-01T00:00', '0099-01-01'])('rejects %s', value => {
    expect(isoDate.safeParse(value).success).toBe(false)
  })

  it('accepts a valid leap day', () => {
    expect(isoDate.safeParse('2028-02-29').success).toBe(true)
  })
})

describe('dateRange', () => {
  it('accepts from <= to', () => {
    expect(dateRange.safeParse({ from: '2027-05-01', to: '2027-05-10' }).success).toBe(true)
    expect(dateRange.safeParse({ from: '2027-05-01', to: '2027-05-01' }).success).toBe(true)
  })

  it('rejects to before from', () => {
    const result = dateRange.safeParse({ from: '2027-05-10', to: '2027-05-01' })
    expect(result.success).toBe(false)
  })

  it(`rejects a range longer than MAX_CALENDAR_DAYS (${MAX_CALENDAR_DAYS})`, () => {
    const result = dateRange.safeParse({ from: '2020-01-01', to: '2021-06-01' })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid date inside the range', () => {
    expect(dateRange.safeParse({ from: '2027-02-30', to: '2027-05-01' }).success).toBe(false)
  })
})

describe('pagination', () => {
  const schema = pagination({ maxPageSize: 50 })

  it('coerces query-string values', () => {
    const result = schema.parse({ page: '2', pageSize: '10' })
    expect(result).toEqual({ page: 2, pageSize: 10 })
  })

  it('defaults page and pageSize when omitted', () => {
    const result = schema.parse({})
    expect(result.page).toBe(1)
    expect(result.pageSize).toBeGreaterThan(0)
    expect(result.pageSize).toBeLessThanOrEqual(50)
  })

  it('caps pageSize at maxPageSize', () => {
    expect(schema.safeParse({ pageSize: '9999' }).success).toBe(false)
  })

  it.each(['0', '-1', 'NaN'])('rejects pageSize=%s', value => {
    expect(schema.safeParse({ pageSize: value }).success).toBe(false)
  })

  it.each(['0', '-1', 'NaN'])('rejects page=%s', value => {
    expect(schema.safeParse({ page: value }).success).toBe(false)
  })
})

describe('safeText', () => {
  const schema = safeText(200)

  it('rejects a string longer than max', () => {
    expect(schema.safeParse('a'.repeat(300)).success).toBe(false)
    expect(schema.safeParse('a'.repeat(200)).success).toBe(true)
  })

  it('strips surrounding whitespace', () => {
    const result = schema.parse('  hello  ')
    expect(result).toBe('hello')
  })

  it('rejects a NUL byte', () => {
    expect(schema.safeParse('abc\u0000def').success).toBe(false)
  })

  it('accepts Arabic text and emoji', () => {
    expect(schema.safeParse('فندق').success).toBe(true)
    expect(schema.safeParse('Great stay 🏨✨').success).toBe(true)
  })
})

describe('uniqueIds', () => {
  const a = '123e4567-e89b-12d3-a456-426614174000'
  const b = '223e4567-e89b-12d3-a456-426614174000'

  it('dedupes repeated ids', () => {
    const result = uniqueIds(10).parse([a, a, b])
    expect(result).toEqual([a, b])
  })

  it('rejects an empty array when required (the default)', () => {
    expect(uniqueIds(10).safeParse([]).success).toBe(false)
  })

  it('allows an empty array when required: false', () => {
    expect(uniqueIds(10, { required: false }).safeParse([]).success).toBe(true)
  })

  it('rejects more than max distinct ids', () => {
    expect(uniqueIds(1).safeParse([a, b]).success).toBe(false)
  })

  it('rejects a raw array longer than max even when every entry is the same duplicate id (DoS guard bypass regression)', () => {
    const oversized = Array.from({ length: 201 }, () => a)
    expect(uniqueIds(200).safeParse(oversized).success).toBe(false)
  })
})
