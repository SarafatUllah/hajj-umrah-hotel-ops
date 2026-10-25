import type { PrincipalKind } from '@hajj/contracts/constants/principals'
import { normalizeEmail } from '@hajj/contracts/utils/email'
import type { DbOrTx } from '@hajj/db/client'
import { clearRateLimit, consumeRateLimit, RATE_LIMITS } from './rateLimit'

export interface LoginRequest {
  clientIp: string
  now: Date
}

/** The rate-limit subjects of one sign-in attempt (see `beginLoginAttempt`). */
export interface LoginAttempt {
  readonly identity: string
  readonly clientIdentity: string
}

/**
 * Takes one attempt's slots (D-P2-8): per client address, per (identity, address) and per identity — atomic, so
 * parallel guesses never pass more checks than the limits; an over-limit caller gets 429 before any password is
 * checked. The identity is the principal kind + organization slug + normalized e-mail, so staff and agency
 * accounts with one e-mail never share counters. Shared by every password sign-in (staff, agency portal).
 */
export async function beginLoginAttempt(db: DbOrTx, principal: PrincipalKind, organizationSlug: string, email: string, request: LoginRequest): Promise<LoginAttempt> {
  const identity = `${principal}\u0000${organizationSlug.trim().toLowerCase()}\u0000${normalizeEmail(email)}`
  const attempt: LoginAttempt = { identity, clientIdentity: `${identity}\u0000${request.clientIp}` }
  await consumeRateLimit(db, RATE_LIMITS.loginPerIp, request.clientIp, request.now)
  await consumeRateLimit(db, RATE_LIMITS.loginPerClientIdentity, attempt.clientIdentity, request.now)
  await consumeRateLimit(db, RATE_LIMITS.loginPerIdentity, attempt.identity, request.now)
  return attempt
}

/** A successful sign-in gives the identity its attempts back. */
export async function clearLoginAttempt(db: DbOrTx, attempt: LoginAttempt): Promise<void> {
  await clearRateLimit(db, RATE_LIMITS.loginPerClientIdentity, attempt.clientIdentity)
  await clearRateLimit(db, RATE_LIMITS.loginPerIdentity, attempt.identity)
}
