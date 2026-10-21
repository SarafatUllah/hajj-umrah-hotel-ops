import { createHash } from 'node:crypto'
import type { DbOrTx } from '@hajj/db/client'
import { TooManyRequestsError } from '../errors/domainError'
import { platformRepos } from '../repositories'

/**
 * Fixed-window rate limits (design v7 §21: "লগইন চেষ্টার সীমা", OTP and public-search limits), backed
 * by PostgreSQL so every API process shares the same counters without Redis (v7 §4). A subject (an IP,
 * a login identifier, a phone number) is stored only as a SHA-256 digest, never in clear text.
 */
export interface RateLimitPolicy {
  /** Key namespace, also the error code suffix. */
  readonly name: string
  readonly limit: number
  readonly windowSeconds: number
}

/**
 * Every policy is consumed BEFORE the guarded check (one atomic UPSERT per hit), so parallel requests can
 * never pass more checks than the limit; a success clears the subject's attempt counters again.
 */
export const RATE_LIMITS = {
  /** Every login attempt from one client address (a hotel office may share one address, hence not lower). */
  loginPerIp: { name: 'login-ip', limit: 60, windowSeconds: 15 * 60 },
  /** Login attempts for one (organization slug, email) from one client address; a success clears it. */
  loginPerClientIdentity: { name: 'login-client', limit: 5, windowSeconds: 15 * 60 },
  /**
   * Login attempts for one (organization slug, email) from anywhere; a success clears it. Higher than the
   * per-client limit, so a stranger alone cannot lock a user out (it needs many addresses), while distributed
   * password guessing stays bounded.
   */
  loginPerIdentity: { name: 'login-identity', limit: 30, windowSeconds: 15 * 60 },
  /** Second-factor codes for one user (login and disabling 2FA); a correct code clears it. Needs the password first. */
  twoFactorAttemptsPerUser: { name: '2fa-user', limit: 5, windowSeconds: 15 * 60 },
} as const satisfies Record<string, RateLimitPolicy>

/** Buckets are kept this long after their window started (far beyond the longest window), then purged. */
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000

export function windowStartFor(policy: RateLimitPolicy, now: Date): Date {
  const windowMs = policy.windowSeconds * 1000
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

export function retryAfterSeconds(policy: RateLimitPolicy, now: Date): number {
  const end = windowStartFor(policy, now).getTime() + policy.windowSeconds * 1000
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000))
}

export function bucketKey(policy: RateLimitPolicy, subject: string): string {
  return `${policy.name}:${createHash('sha256').update(subject, 'utf8').digest('hex')}`
}

/** Counts one attempt and throws 429 once the window's count exceeds the limit. */
export async function consumeRateLimit(db: DbOrTx, policy: RateLimitPolicy, subject: string, now: Date): Promise<void> {
  const hits = await platformRepos(db).rateLimits.hit(bucketKey(policy, subject), windowStartFor(policy, now))
  if (hits > policy.limit) throw new TooManyRequestsError('TOO_MANY_REQUESTS', retryAfterSeconds(policy, now), 'Too many attempts, try again later')
}

export async function clearRateLimit(db: DbOrTx, policy: RateLimitPolicy, subject: string): Promise<void> {
  await platformRepos(db).rateLimits.reset(bucketKey(policy, subject))
}

/** Housekeeping for the daily cleanup job: removes buckets older than the retention period. */
export async function purgeExpiredRateLimits(db: DbOrTx, now: Date): Promise<number> {
  return platformRepos(db).rateLimits.deleteOlderThan(new Date(now.getTime() - RATE_LIMIT_RETENTION_MS))
}
