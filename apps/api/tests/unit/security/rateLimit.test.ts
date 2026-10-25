import { describe, expect, it } from 'vitest'
import { bucketKey, RATE_LIMITS, retryAfterSeconds, windowStartFor, type RateLimitPolicy } from '../../../server/security/rateLimit'

const policy: RateLimitPolicy = { name: 'test', limit: 3, windowSeconds: 900 }

describe('rate-limit windows', () => {
  it('aligns windows to multiples of the window length (UTC epoch)', () => {
    expect(windowStartFor(policy, new Date('2026-10-21T10:00:00.000Z')).toISOString()).toBe('2026-10-21T10:00:00.000Z')
    expect(windowStartFor(policy, new Date('2026-10-21T10:14:59.999Z')).toISOString()).toBe('2026-10-21T10:00:00.000Z')
    expect(windowStartFor(policy, new Date('2026-10-21T10:15:00.000Z')).toISOString()).toBe('2026-10-21T10:15:00.000Z')
  })

  it('reports the seconds left in the window, never less than 1', () => {
    expect(retryAfterSeconds(policy, new Date('2026-10-21T10:00:00.000Z'))).toBe(900)
    expect(retryAfterSeconds(policy, new Date('2026-10-21T10:14:30.000Z'))).toBe(30)
    expect(retryAfterSeconds(policy, new Date('2026-10-21T10:14:59.999Z'))).toBe(1)
  })
})

describe('bucketKey', () => {
  it('namespaces by policy and never stores the subject in clear text', () => {
    const key = bucketKey(policy, '203.0.113.7')
    expect(key).toMatch(/^test:[0-9a-f]{64}$/)
    expect(key).not.toContain('203.0.113.7')
    expect(bucketKey(policy, '203.0.113.7')).toBe(key)
    expect(bucketKey({ ...policy, name: 'other' }, '203.0.113.7')).not.toBe(key)
  })

  it('policy names are unique', () => {
    const names = Object.values(RATE_LIMITS).map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('a stranger cannot lock out an identity from one address: the per-identity limit is above the per-client one', () => {
    expect(RATE_LIMITS.loginPerIdentity.limit).toBeGreaterThan(RATE_LIMITS.loginPerClientIdentity.limit)
  })
})
