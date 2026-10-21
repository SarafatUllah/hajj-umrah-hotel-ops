import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors/domainError'
import { tenantRepos, type TenantRepos } from '../repositories'
import type { UserRow } from '../repositories/tenant/userRepository'
import type { AuthContext } from '../security/authContext'
import { requireOrgPermission } from '../security/authorize'
import { clearRateLimit, consumeRateLimit, RATE_LIMITS } from '../security/rateLimit'
import { generateTotpSecret, totpUri, verifyTotp } from '../security/totp'
import { usePiiCipher } from '../utils/pii'
import { recordAudit } from './audit'

/** Shown by authenticator apps next to the account. */
export const TOTP_ISSUER = 'Hajj Hotel Ops'

/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof tenantRepos>[0]

/**
 * The encryption context of a user's TOTP secret: binds the ciphertext to that user, so a secret copied
 * onto another user's row fails to decrypt. The pending and the active column share it (enabling moves
 * the pending ciphertext as is).
 */
const totpSecretContext = (userId: string) => `app_user.totp_secret:${userId}`

const readSecret = (userId: string, ciphertext: string) => usePiiCipher().decrypt(ciphertext, totpSecretContext(userId))

export interface TwoFactorStatus {
  enabled: boolean
  /** A setup was started and not confirmed yet. */
  setupPending: boolean
  /** One of the user's roles requires two-factor authentication. */
  requiredByRole: boolean
}

export interface TwoFactorSetup {
  /** Base32 secret, shown once for manual entry. */
  secret: string
  /** `otpauth://` URI, rendered as a QR code by the client. */
  otpauthUri: string
}

export type SecondFactorCheck = 'ok' | 'required' | 'invalid'

/**
 * Takes one of the user's code attempts BEFORE checking (atomic, so parallel guesses never exceed the
 * limit; 429 once used up); a correct code gives the attempts back.
 */
async function withCodeAttempt(db: Db, userId: string, now: Date, check: () => Promise<boolean>): Promise<boolean> {
  await consumeRateLimit(db, RATE_LIMITS.twoFactorAttemptsPerUser, userId, now)
  const accepted = await check()
  if (accepted) await clearRateLimit(db, RATE_LIMITS.twoFactorAttemptsPerUser, userId)
  return accepted
}

/**
 * The login step after a correct password: a user without 2FA passes; an enrolled user must send a code
 * for a step later than the last accepted one, and the step is recorded atomically (a code works once).
 */
export async function checkSecondFactor(db: Db, repos: TenantRepos, user: UserRow, code: string | undefined, now: Date): Promise<SecondFactorCheck> {
  const secret = user.totpSecret
  if (secret === null) return 'ok'
  if (code === undefined) return 'required'
  const accepted = await withCodeAttempt(db, user.id, now, async () => {
    const result = verifyTotp(readSecret(user.id, secret), code, now, user.totpLastStep)
    return result.ok && await repos.users.advanceTotpStep(user.id, result.step)
  })
  return accepted ? 'ok' : 'invalid'
}

async function loadUser(repos: TenantRepos, userId: string, forUpdate: boolean): Promise<UserRow> {
  const user = forUpdate ? await repos.users.findByIdForUpdate(userId) : await repos.users.findById(userId)
  if (!user) throw new NotFoundError('USER_NOT_FOUND')
  return user
}

const alreadyEnabled = () => new ConflictError('TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled')
const notEnabled = () => new ConflictError('TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled')
const invalidCode = () => new ValidationError('TWO_FACTOR_CODE_INVALID', 'The authentication code is not valid')

export async function getTwoFactorStatus(ctx: AuthContext): Promise<TwoFactorStatus> {
  const repos = tenantRepos(ctx.db, ctx.scope)
  const [user, requiredByRole] = await Promise.all([loadUser(repos, ctx.identity.userId, false), repos.roles.requiresTwoFactorForUser(ctx.identity.userId)])
  return { enabled: user.totpEnabledAt !== null, setupPending: user.totpPendingSecret !== null, requiredByRole }
}

/** Starts (or restarts) enrolment: a new pending secret replaces any earlier unconfirmed one. Audited. */
export async function beginTwoFactorSetup(ctx: AuthContext): Promise<TwoFactorSetup> {
  const secret = generateTotpSecret()
  const email = await ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const user = await loadUser(repos, ctx.identity.userId, true)
    if (user.totpEnabledAt !== null) throw alreadyEnabled()
    await repos.users.setPendingTotpSecret(user.id, usePiiCipher().encrypt(secret, totpSecretContext(user.id)))
    await recordAudit(repos.audit, user.id, { entityType: 'app_user', entityId: user.id, action: 'TWO_FACTOR_SETUP_STARTED' })
    return user.email
  })
  return { secret, otpauthUri: totpUri({ secret, issuer: TOTP_ISSUER, account: email }) }
}

/** Confirms enrolment with a code from the pending secret; the secret becomes active. Returns the new session version. */
export async function confirmTwoFactorSetup(ctx: AuthContext, code: string): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const user = await loadUser(repos, ctx.identity.userId, true)
    if (user.totpEnabledAt !== null) throw alreadyEnabled()
    if (user.totpPendingSecret === null) throw new ConflictError('TWO_FACTOR_SETUP_REQUIRED', 'Start two-factor setup first')

    const result = verifyTotp(readSecret(user.id, user.totpPendingSecret), code, ctx.now())
    if (!result.ok) throw invalidCode()

    const sessionVersion = await repos.users.enableTotp(user.id, user.totpPendingSecret, ctx.now(), result.step)
    await recordAudit(repos.audit, user.id, { entityType: 'app_user', entityId: user.id, action: 'TWO_FACTOR_ENABLED' })
    return sessionVersion!
  })
}

/**
 * Turns two-factor authentication off; a current code is required, so a stolen session alone cannot do
 * it. Code attempts are rate limited per user (taken outside the transaction, so a rollback keeps them).
 * Returns the new session version.
 */
export async function disableTwoFactor(ctx: AuthContext, code: string): Promise<number> {
  const now = ctx.now()
  let sessionVersion: number | null = null
  const accepted = await withCodeAttempt(ctx.db, ctx.identity.userId, now, () => ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const user = await loadUser(repos, ctx.identity.userId, true)
    if (user.totpSecret === null) throw notEnabled()
    if (!verifyTotp(readSecret(user.id, user.totpSecret), code, now, user.totpLastStep).ok) return false

    sessionVersion = await repos.users.disableTotp(user.id)
    await recordAudit(repos.audit, user.id, { entityType: 'app_user', entityId: user.id, action: 'TWO_FACTOR_DISABLED' })
    return true
  }))
  if (!accepted || sessionVersion === null) throw invalidCode()
  return sessionVersion
}

/**
 * Lost device (or a second factor enrolled by someone else): an administrator with `user.manage` removes
 * another user's second factor and signs them out everywhere; with enforcement on they enrol again at the
 * next sign-in. Never one's own (use disable), and a caller without `allHotels` can never reset a user who
 * has it (the same escalation rule as hotel access). Audited with the reason.
 */
export async function resetTwoFactor(ctx: AuthContext, userId: string, reason: string): Promise<void> {
  requireOrgPermission(ctx, 'user.manage')
  if (userId === ctx.identity.userId) throw new ForbiddenError('ESCALATION_DENIED')

  await ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const target = await loadUser(repos, userId, true)
    if (target.allHotels && !ctx.authz.allHotels) throw new ForbiddenError('ESCALATION_DENIED')
    if (target.totpSecret === null && target.totpPendingSecret === null) throw notEnabled()

    await repos.users.disableTotp(target.id)
    await recordAudit(repos.audit, ctx.identity.userId, { entityType: 'app_user', entityId: target.id, action: 'TWO_FACTOR_RESET', reason })
  })
}
