import { randomUUID } from 'node:crypto'
import { OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS } from '@hajj/contracts/constants/accounts'
import type { OtpRequestInput, OtpVerifyInput } from '@hajj/contracts/schemas/customer'
import type { CustomerMe, OtpChallengeIssued } from '@hajj/contracts/types/customer'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, ForbiddenError, UnauthenticatedError, ValidationError } from '../../errors/domainError'
import { useSmsSender } from '../../notifications/sms'
import { accountsRepos } from '../../repositories'
import type { CustomerContext } from '../../security/customerContext'
import type { LoginRequest } from '../../security/loginThrottle'
import type { OrganizationScope } from '../../security/scope'
import { generateOtpCode, hashOtpCode, otpCodeMatches } from '../../security/otp'
import { assertHuman } from '../../security/captcha'
import { clearRateLimit, consumeRateLimit, RATE_LIMITS, type RateLimitPolicy } from '../../security/rateLimit'
import { resolveTenantBySlug } from '../../security/tenantResolver'
import { useDb } from '../../utils/db'
import { getEnv } from '../../utils/env'

export type { CustomerMe, OtpChallengeIssued }

/** What a customer session carries (identity only). */
export interface CustomerSessionUser { id: string, organizationId: string, phone: string, fullName: string, sessionVersion: number, isNew: boolean }


/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof accountsRepos>[0]

async function tenantScopeFor(db: Db, organizationSlug: string) {
  const tenant = await resolveTenantBySlug(db, organizationSlug)
  if (!tenant) throw new ValidationError('INVALID_REFERENCE', 'Unknown organization')
  return tenant.scope
}

const invalidCode = () => new UnauthenticatedError('OTP_INVALID', 'The code is not valid or has expired')

/** The organization's SMS budget (env-configurable): per hour, and per day with an operator alert in the log. */
function smsBudget(): RateLimitPolicy[] {
  const env = getEnv()
  return [
    { name: 'otp-org-hour', limit: env.SMS_HOURLY_LIMIT, windowSeconds: 60 * 60 },
    { name: 'otp-org-day', limit: env.SMS_DAILY_LIMIT, windowSeconds: 24 * 60 * 60 },
  ]
}

/** SMS-pumping guard: only the configured countries (calling codes) receive codes. */
function assertSupportedDestination(phone: string): void {
  if (!getEnv().SMS_ALLOWED_CALLING_CODES.some(code => phone.startsWith(`+${code}`))) {
    throw new ValidationError('PHONE_NOT_SUPPORTED', 'Sign-in codes cannot be sent to this country')
  }
}

/**
 * Texts a sign-in code (v7 §21: phone OTP for the public site; sign-up and sign-in are the same flow). Before
 * anything is created or sent: the destination country must be allowed, the bot check pass (when configured),
 * and the limits hold — per client address, one code per phone per minute, 3 per phone per 15 minutes, and the
 * organization's hourly and daily SMS budget. The answer is the same whether or not the phone has an account.
 * A new code closes the phone's older ones once it is sent (a failed SMS leaves them usable); only a hash of the
 * code is stored.
 */
export async function requestCustomerOtp(input: OtpRequestInput, request: LoginRequest): Promise<OtpChallengeIssued> {
  const db = useDb()
  assertSupportedDestination(input.phone)
  await consumeRateLimit(db, RATE_LIMITS.otpRequestPerIp, request.clientIp, request.now)
  await assertHuman(input.captchaToken, request.clientIp)
  const scope = await tenantScopeFor(db, input.organizationSlug)
  const phoneKey = `${scope.organizationId}\u0000${input.phone}`
  await consumeRateLimit(db, RATE_LIMITS.otpResendCooldown, phoneKey, request.now)
  await consumeRateLimit(db, RATE_LIMITS.otpRequestPerPhone, phoneKey, request.now)
  for (const policy of smsBudget()) {
    await consumeRateLimit(db, policy, scope.organizationId, request.now).catch((error: unknown) => {
      console.warn(`[sms] organization ${scope.organizationId} reached its ${policy.name} SMS budget`)
      throw error
    })
  }

  const challengeId = randomUUID()
  const code = generateOtpCode()
  const challenges = accountsRepos(db, scope).otpChallenges
  await challenges.insert({ id: challengeId, phone: input.phone, codeHash: hashOtpCode(challengeId, code), expiresAt: new Date(request.now.getTime() + OTP_TTL_SECONDS * 1000) })
  await useSmsSender().send({ to: input.phone, text: `Your verification code is ${code}. It expires in ${OTP_TTL_SECONDS / 60} minutes. Do not share it.` })
  await challenges.closeOpenForPhone(input.phone, request.now, challengeId)
  return { challengeId, expiresInSeconds: OTP_TTL_SECONDS }
}

/**
 * Checks a code and signs the customer in, creating the account on first use (a new customer must give a name:
 * 422 `FULL_NAME_REQUIRED`, the challenge stays usable). Every check counts an attempt atomically (at most
 * OTP_MAX_ATTEMPTS per challenge), plus limits per client address, per phone and address, and (higher) per phone across challenges; unknown,
 * expired, used and wrong codes all answer 401 `OTP_INVALID`. Consuming the code, creating the customer and
 * recording the sign-in are one transaction: a refusal after the code check leaves the code usable.
 */
export async function verifyCustomerOtp(input: OtpVerifyInput, request: LoginRequest): Promise<CustomerSessionUser> {
  const db = useDb()
  await consumeRateLimit(db, RATE_LIMITS.otpVerifyPerIp, request.clientIp, request.now)
  const scope = await tenantScopeFor(db, input.organizationSlug)

  const challenge = await accountsRepos(db, scope).otpChallenges.registerAttempt(input.challengeId, request.now, OTP_MAX_ATTEMPTS)
  if (!challenge) throw invalidCode()
  const phoneKey = `${scope.organizationId}\u0000${challenge.phone}`
  const phoneAddressKey = `${phoneKey}\u0000${request.clientIp}`
  await consumeRateLimit(db, RATE_LIMITS.otpVerifyPerPhone, phoneAddressKey, request.now)
  await consumeRateLimit(db, RATE_LIMITS.otpVerifyPerPhoneTotal, phoneKey, request.now)
  if (!otpCodeMatches(challenge.id, input.code, challenge.codeHash)) throw invalidCode()

  const signedIn = await db.transaction(async (tx) => {
    const repos = accountsRepos(tx, scope)
    if (!await repos.otpChallenges.consume(challenge.id, request.now)) throw invalidCode()
    const existing = await repos.customers.findByPhone(challenge.phone)
    if (!existing && !input.fullName) throw new ValidationError('FULL_NAME_REQUIRED', 'Tell us your name to create your account')
    if (existing && !existing.isActive) throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled')
    const customerRow = existing ?? await repos.customers.insert({ phone: challenge.phone, fullName: input.fullName!, phoneVerifiedAt: request.now })
    await repos.customers.recordLogin(customerRow.id, request.now)
    return { customerRow, isNew: !existing }
  }).catch(rethrowDbError)

  await clearRateLimit(db, RATE_LIMITS.otpVerifyPerPhone, phoneAddressKey)
  await clearRateLimit(db, RATE_LIMITS.otpVerifyPerPhoneTotal, phoneKey)
  const { customerRow, isNew } = signedIn
  return { id: customerRow.id, organizationId: customerRow.organizationId, phone: challenge.phone, fullName: customerRow.fullName, sessionVersion: customerRow.sessionVersion, isNew }
}

/** "Sign out everywhere": ends every session of the customer (the caller's included). */
export async function signOutEverywhere(ctx: CustomerContext): Promise<void> {
  await accountsRepos(ctx.db, ctx.scope).customers.bumpSessionVersion(ctx.identity.customerId)
}

export function getCustomerMe(ctx: CustomerContext): CustomerMe {
  return { id: ctx.identity.customerId, phone: ctx.identity.phone, fullName: ctx.identity.fullName }
}

/** Is the customer's account open (not closed, not disabled)? The booking module asks under its request lock. */
export async function isCustomerOpen(db: Db, scope: OrganizationScope, customerId: string): Promise<boolean> {
  const row = await accountsRepos(db, scope).customers.findById(customerId)
  return Boolean(row?.isActive && !row.closedAt)
}

/** Step 15b: the account is closed — anonymized, inactive, every session ended (409 `ACCOUNT_CLOSED` when it already is). */
export async function closeCustomerRecord(db: Db, scope: OrganizationScope, customerId: string, at: Date): Promise<void> {
  if (!await accountsRepos(db, scope).customers.close(customerId, at)) throw new ConflictError('ACCOUNT_CLOSED', 'This account is already closed')
}
