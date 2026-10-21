import { describe, expect, it } from 'vitest'
import { staffLoginSchema } from '@hajj/contracts/schemas/auth'
import { createCapacityPeriodSchema, updateCapacityPeriodSchema } from '@hajj/contracts/schemas/capacityPeriod'

const LOGIN = { organizationSlug: 'demo', email: 'admin@demo.test', password: 'secret' }

describe('staffLoginSchema (POST /api/auth/login)', () => {
  it('takes the organization, email and password, and a 6-digit code once asked for it', () => {
    expect(staffLoginSchema.safeParse(LOGIN).success).toBe(true)
    expect(staffLoginSchema.safeParse({ ...LOGIN, totpCode: '123456' }).success).toBe(true)
    expect(staffLoginSchema.safeParse({ ...LOGIN, totpCode: '12345' }).success).toBe(false)
  })

  it('refuses an empty or oversized field before any hashing', () => {
    expect(staffLoginSchema.safeParse({ ...LOGIN, organizationSlug: '' }).success).toBe(false)
    expect(staffLoginSchema.safeParse({ ...LOGIN, email: 'not-an-email' }).success).toBe(false)
    expect(staffLoginSchema.safeParse({ ...LOGIN, password: 'x'.repeat(1025) }).success).toBe(false)
  })
})

describe('a season needs a name', () => {
  it('an empty name is refused on create and on edit', () => {
    const season = { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' }
    expect(createCapacityPeriodSchema.safeParse(season).success).toBe(true)
    expect(createCapacityPeriodSchema.safeParse({ ...season, name: ' ' }).success).toBe(false)
    expect(updateCapacityPeriodSchema.safeParse({ name: '' }).success).toBe(false)
  })
})
