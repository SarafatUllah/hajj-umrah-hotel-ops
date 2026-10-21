import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { platformRepos } from '../../../server/repositories'
import { JOBS } from '../../../server/jobs'
import { rateLimitCleanupJob } from '../../../server/jobs/securityJobs'
import { TooManyRequestsError } from '../../../server/errors/domainError'
import { bucketKey, clearRateLimit, consumeRateLimit, purgeExpiredRateLimits, RATE_LIMIT_RETENTION_MS, type RateLimitPolicy } from '../../../server/security/rateLimit'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const repo = platformRepos(db).rateLimits
const policy: RateLimitPolicy = { name: 'test', limit: 3, windowSeconds: 900 }
const T0 = new Date('2026-10-21T10:00:00.000Z')
const LATER_IN_WINDOW = new Date('2026-10-21T10:10:00.000Z')
const NEXT_WINDOW = new Date('2026-10-21T10:15:00.000Z')

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('PlatformRateLimitRepository', () => {
  it('counts hits per key and window, restarting the count in a new window', async () => {
    expect(await repo.hit('k', T0)).toBe(1)
    expect(await repo.hit('k', T0)).toBe(2)
    expect(await repo.hit('other', T0)).toBe(1)
    expect(await repo.count('k', T0)).toBe(2)

    expect(await repo.hit('k', NEXT_WINDOW)).toBe(1)
    expect(await repo.count('k', NEXT_WINDOW)).toBe(1)
    expect(await repo.count('k', new Date(NEXT_WINDOW.getTime() + 900_000))).toBe(0)
    expect(await repo.count('missing', T0)).toBe(0)
  })

  it('is atomic under concurrency: 25 parallel hits produce the counts 1..25 exactly once each', async () => {
    const counts = await Promise.all(Array.from({ length: 25 }, () => repo.hit('busy', T0)))
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
  })

  it('a hit stamped with an older window (a lagging clock) counts against the newer window and never moves it back', async () => {
    await repo.hit('skew', NEXT_WINDOW)
    expect(await repo.hit('skew', T0)).toBe(2)
    expect(await repo.count('skew', NEXT_WINDOW)).toBe(2)
    expect(await repo.count('skew', T0)).toBe(2)
    expect(await repo.hit('skew', NEXT_WINDOW)).toBe(3)
  })

  it('reset removes one key; deleteOlderThan removes only buckets whose window started earlier', async () => {
    await repo.hit('a', T0)
    await repo.hit('b', T0)
    await repo.hit('c', NEXT_WINDOW)
    await repo.reset('a')
    expect(await repo.count('a', T0)).toBe(0)

    expect(await repo.deleteOlderThan(NEXT_WINDOW)).toBe(1)
    expect(await repo.count('b', T0)).toBe(0)
    expect(await repo.count('c', NEXT_WINDOW)).toBe(1)
  })
})

describe('rate-limit service', () => {
  it('consumeRateLimit allows `limit` attempts per window, then throws 429 with the seconds left', async () => {
    for (let i = 0; i < policy.limit; i++) await consumeRateLimit(db, policy, 'ip-1', T0)

    const error = await consumeRateLimit(db, policy, 'ip-1', LATER_IN_WINDOW).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TooManyRequestsError)
    expect((error as TooManyRequestsError).retryAfterSeconds).toBe(300)

    await expect(consumeRateLimit(db, policy, 'ip-2', T0)).resolves.toBeUndefined()
    await expect(consumeRateLimit(db, policy, 'ip-1', NEXT_WINDOW)).resolves.toBeUndefined()
  })

  it('consume is atomic: of 12 parallel attempts exactly `limit` pass; clear gives the attempts back', async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeRateLimit(db, policy, 'burst', T0)))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(policy.limit)
    expect(results.filter(r => r.status === 'rejected' && r.reason instanceof TooManyRequestsError)).toHaveLength(12 - policy.limit)

    await clearRateLimit(db, policy, 'burst')
    await expect(consumeRateLimit(db, policy, 'burst', T0)).resolves.toBeUndefined()
  })

  it('stores only the hashed subject', async () => {
    await consumeRateLimit(db, policy, '203.0.113.7', T0)
    expect(await repo.count(bucketKey(policy, '203.0.113.7'), T0)).toBe(1)
    expect(await repo.count('test:203.0.113.7', T0)).toBe(0)
  })
})

describe('security.rate-limit-cleanup job', () => {
  it('is registered as a light, scheduled job', () => {
    expect(JOBS).toContain(rateLimitCleanupJob)
    expect(rateLimitCleanupJob.tier).toBe('light')
    expect(rateLimitCleanupJob.schedule?.cron).toBeTruthy()
  })

  it('purges buckets older than the retention period and keeps recent ones', async () => {
    const now = new Date('2026-10-22T12:00:00.000Z')
    await repo.hit('old', new Date(now.getTime() - RATE_LIMIT_RETENTION_MS - 1000))
    await repo.hit('recent', new Date(now.getTime() - 60_000))

    expect(await purgeExpiredRateLimits(db, now)).toBe(1)
    await rateLimitCleanupJob.handle({}, { db, jobId: 'test' })
    expect(await repo.count('recent', new Date(now.getTime() - 60_000))).toBe(1)
  })
})
