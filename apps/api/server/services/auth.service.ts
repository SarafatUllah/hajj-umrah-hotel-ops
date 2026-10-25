import { useDb } from '../utils/db'
import { tenantRepos, type TenantRepos } from '../repositories'
import type { UserRow } from '../repositories/tenant/userRepository'
import { beginLoginAttempt, clearLoginAttempt, type LoginRequest } from '../security/loginThrottle'
import { resolveTenantBySlug } from '../security/tenantResolver'
import { verifyPassword, TIMING_SAFETY_DUMMY_HASH } from '../utils/password'
import { normalizeEmail } from '@hajj/contracts/utils/email'
import { checkSecondFactor } from './twoFactorService'

export interface AuthenticatedUser {
  id: string
  organizationId: string
  email: string
  fullName: string
}

/** What a successful login puts into the session besides the identity. */
export interface LoginSession {
  /** The user's `session_version`: a later 2FA change invalidates this session. */
  sessionVersion: number
}

export interface AuthenticationResult {
  user: AuthenticatedUser
}

export interface LoginInput {
  organizationSlug: string
  email: string
  password: string
  /** The current code from the user's authenticator app (required once 2FA is enabled). */
  totpCode?: string
}

export type { LoginRequest }

export type LoginOutcome =
  | { status: 'ok', user: AuthenticatedUser, session: LoginSession }
  | { status: 'invalid-credentials' }
  | { status: 'two-factor-required' }
  | { status: 'invalid-two-factor' }

/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof tenantRepos>[0]

interface VerifiedCredentials {
  repos: TenantRepos
  user: UserRow
}

/**
 * Tenant-scoped login: email is unique only within an organization
 * (app_user_org_email_unique), not globally, so the organization must be
 * resolved first — a lookup by email alone could match a same-named user
 * in a different organization and authenticate against the wrong tenant.
 */
async function verifyCredentials(db: Db, organizationSlug: string, email: string, password: string): Promise<VerifiedCredentials | null> {
  const tenant = await resolveTenantBySlug(db, organizationSlug)
  const repos = tenant ? tenantRepos(db, tenant.scope) : null
  const foundUser = repos ? await repos.users.findActiveByEmail(normalizeEmail(email)) : null

  // Always run exactly one Argon2 verify, whether or not the organization
  // and user exist, so "unknown organization", "unknown email", and "wrong
  // password" are indistinguishable by response time as well as by message.
  const passwordOk = await verifyPassword(password, foundUser?.passwordHash ?? TIMING_SAFETY_DUMMY_HASH)
  if (!repos || !foundUser || !passwordOk) return null
  return { repos, user: foundUser }
}

const toAuthenticatedUser = (user: UserRow): AuthenticatedUser => ({
  id: user.id,
  organizationId: user.organizationId,
  email: user.email,
  fullName: user.fullName,
})

/**
 * Password check only (no rate limiting, no second factor) — seeds and tests use it to prove a
 * credential works. Identity only (Task 7): authorization (permissions, allHotels, hotelIds) is never
 * resolved here and never stored in the session — every request resolves it fresh via resolveAuthContext.
 */
export async function authenticate(organizationSlug: string, email: string, password: string): Promise<AuthenticationResult | null> {
  const verified = await verifyCredentials(useDb(), organizationSlug, email, password)
  return verified ? { user: toAuthenticatedUser(verified.user) } : null
}

/**
 * The staff login (design v7 §21): every attempt first takes its rate-limit slots (`beginLoginAttempt`; 429
 * before any password is checked), then the password, then — for an enrolled user — the TOTP code (its own
 * per-user attempt limit). A success clears the identity's counters.
 */
export async function login(input: LoginInput, request: LoginRequest): Promise<LoginOutcome> {
  const db = useDb()
  const attempt = await beginLoginAttempt(db, 'staff', input.organizationSlug, input.email, request)

  const verified = await verifyCredentials(db, input.organizationSlug, input.email, input.password)
  if (!verified) return { status: 'invalid-credentials' }

  const secondFactor = await checkSecondFactor(db, verified.repos, verified.user, input.totpCode, request.now)
  if (secondFactor === 'required') return { status: 'two-factor-required' }
  if (secondFactor === 'invalid') return { status: 'invalid-two-factor' }

  await clearLoginAttempt(db, attempt)
  return { status: 'ok', user: toAuthenticatedUser(verified.user), session: { sessionVersion: verified.user.sessionVersion } }
}
