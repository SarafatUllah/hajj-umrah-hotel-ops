import { describe, expect, it } from 'vitest'
import { emailAddress } from '@hajj/contracts/schemas/common'
import { otpRequestSchema, otpVerifySchema } from '@hajj/contracts/schemas/customer'

const base = { organizationSlug: 'demo' }

describe('customer sign-in schemas (D-P2-68)', () => {
  it('a code request names a phone or an e-mail address: exactly one of the two', () => {
    expect(otpRequestSchema.parse({ ...base, phone: '+966 50 123 4567' })).toEqual({ ...base, phone: '+966501234567' })
    expect(otpRequestSchema.parse({ ...base, email: 'aisha@example.com', captchaToken: 'tok' })).toEqual({ ...base, email: 'aisha@example.com', captchaToken: 'tok' })
    expect(otpRequestSchema.safeParse({ ...base }).success).toBe(false)
    expect(otpRequestSchema.safeParse({ ...base, phone: '+966501234567', email: 'aisha@example.com' }).success).toBe(false)
  })

  it('a malformed address is refused on the email field (the site shows it there)', () => {
    const result = otpRequestSchema.safeParse({ ...base, email: 'aisha@' })
    expect(result.success).toBe(false)
    expect(result.error!.issues).toEqual([expect.objectContaining({ path: ['email'] })])
  })

  it('an address is stored as the platform compares it: trimmed and lower-cased, at most 254 characters', () => {
    expect(emailAddress.parse('  Aisha.Rahman@Example.COM ')).toBe('aisha.rahman@example.com')
    const local = 'a'.repeat(64)
    const longest = `${local}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`
    expect(longest).toHaveLength(254)
    expect(emailAddress.safeParse(longest).success).toBe(true)
    expect(emailAddress.safeParse(`x${longest}`).success).toBe(false)
    for (const bad of ['', 'aisha', '@example.com', 'aisha@example', 'a b@example.com', 'aisha@@example.com']) expect(emailAddress.safeParse(bad).success, bad).toBe(false)
  })

  it('verifying is unchanged: the challenge knows where its code went', () => {
    expect(otpVerifySchema.parse({ ...base, challengeId: '00000000-0000-4000-8000-000000000000', code: '123456' })).toMatchObject({ code: '123456' })
    expect(otpVerifySchema.safeParse({ ...base, challengeId: '00000000-0000-4000-8000-000000000000', code: '123456', email: 'aisha@example.com' }).success).toBe(false)
  })
})
