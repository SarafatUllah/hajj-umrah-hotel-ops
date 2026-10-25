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
  /** Current-password checks of one agency user changing their password (a stolen session cannot guess it freely). */
  passwordChangePerAgencyUser: { name: 'password-change-agency-user', limit: 5, windowSeconds: 15 * 60 },
  /** Second-factor codes for one user (login and disabling 2FA); a correct code clears it. Needs the password first. */
  twoFactorAttemptsPerUser: { name: '2fa-user', limit: 5, windowSeconds: 15 * 60 },
  /** Agency self-registrations from one client address (the public agency portal form). */
  agencyRegistrationPerIp: { name: 'agency-register', limit: 5, windowSeconds: 60 * 60 },
  /** Agency self-registrations per organization from anywhere (caps a PENDING-queue flood from many addresses). */
  agencyRegistrationPerOrganization: { name: 'agency-register-org', limit: 50, windowSeconds: 60 * 60 },
  /** Sign-in codes texted to one phone (each SMS costs money and annoys the owner). */
  otpRequestPerPhone: { name: 'otp-phone', limit: 3, windowSeconds: 15 * 60 },
  /** At most one code per phone per minute (no burst of texts to a victim). */
  otpResendCooldown: { name: 'otp-cooldown', limit: 1, windowSeconds: 60 },
  /** Sign-in code requests from one client address (generous: carrier NAT and hotel Wi-Fi share addresses). */
  otpRequestPerIp: { name: 'otp-ip', limit: 30, windowSeconds: 15 * 60 },
  /** Code verifications from one client address (each challenge also allows only OTP_MAX_ATTEMPTS). */
  otpVerifyPerIp: { name: 'otp-verify-ip', limit: 60, windowSeconds: 15 * 60 },
  /**
   * Code verifications for one phone from one address, across challenges: per address, so one stranger guessing at
   * someone's phone does not lock its owner out.
   */
  otpVerifyPerPhone: { name: 'otp-verify-phone', limit: 10, windowSeconds: 60 * 60 },
  /**
   * And for one phone from every address together, higher: guessing spread over many addresses stays at 30 tries an
   * hour (under the 12 codes × `OTP_MAX_ATTEMPTS` a phone could otherwise be tried with). A stranger who fills it
   * could already keep the owner from getting codes (`otpRequestPerPhone`): that trade was taken for the bound.
   */
  otpVerifyPerPhoneTotal: { name: 'otp-verify-phone-total', limit: 30, windowSeconds: 60 * 60 },
  /** Quote requests per agency (each takes a reference number and lands in the sellers' queue). */
  quoteRequestPerAgency: { name: 'quote-agency', limit: 30, windowSeconds: 60 * 60 },
  /** Stay searches per agency (each runs the allocator: CPU on the request path, ticket 3). */
  staySearchPerAgency: { name: 'stay-search-agency', limit: 600, windowSeconds: 60 * 60 },
  /** Holds per agency (each locks rooms for the hold minutes; the quota bounds the seats, this bounds the churn). */
  holdPerAgency: { name: 'hold-agency', limit: 120, windowSeconds: 60 * 60 },
  /** Full views of a booking's passport data per staff user (each is logged; this bounds bulk export by a stolen session). */
  piiRevealPerStaff: { name: 'pii-reveal-staff', limit: 60, windowSeconds: 60 * 60 },
  /** Full views of its own guest lists per agency user (the same bound for the agency portal). */
  guestListPerAgencyUser: { name: 'guest-list-agency-user', limit: 300, windowSeconds: 60 * 60 },
  /** Passport photo uploads per user, agency or staff (each is stored and read in the worker; a 580-pilgrim group fits in an hour). */
  passportUploadPerUser: { name: 'passport-upload-user', limit: 600, windowSeconds: 60 * 60 },
  /** Passport images opened for review per user (each is decrypted and logged). */
  passportImagePerUser: { name: 'passport-image-user', limit: 1200, windowSeconds: 60 * 60 },
  /** Passports sent to the external AI reader per organization (each is a paid call and a disclosure). */
  passportAiPerOrganization: { name: 'passport-ai-org', limit: 300, windowSeconds: 60 * 60 },
  /** The public site's hotel list per client address (unauthenticated; carrier NAT shares addresses, hence generous). */
  publicCatalogPerIp: { name: 'public-catalog-ip', limit: 300, windowSeconds: 15 * 60 },
  /** Stay searches per customer (each runs the allocator; a family compares a few hotels and dates). */
  staySearchPerCustomer: { name: 'stay-search-customer', limit: 120, windowSeconds: 60 * 60 },
  /**
   * Request attempts per customer per day that reach the locks (each locks rooms; one may be open at a time, v7 §10).
   * Counted after the free checks (the lead's passport), so a family retrying a busy hotel is not shut out.
   */
  requestPerCustomer: { name: 'request-customer', limit: 30, windowSeconds: 24 * 60 * 60 },
  /** Pilgrim detail saves per customer (a family's handful of passports, corrected a few times). */
  guestSavePerCustomer: { name: 'guest-save-customer', limit: 120, windowSeconds: 60 * 60 },
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
