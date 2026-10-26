import { randomUUID } from 'node:crypto'
import { OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS } from '@hajj/contracts/constants/accounts'
import type { OtpRequestInput, OtpVerifyInput } from '@hajj/contracts/schemas/customer'
import type { CustomerMe, OtpChallengeIssued } from '@hajj/contracts/types/customer'
import { emailLimitSubject, verifiedEmailOf } from '../../domain/accounts/customerRules'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, ForbiddenError, UnauthenticatedError, ValidationError } from '../../errors/domainError'
import { composeEmail, useEmailSender, type EmailMessage } from '../../notifications/email'
import { useSmsSender } from '../../notifications/sms'
import { accountsRepos, type CustomerRow, type OtpChallengeRow, type OtpDestination } from '../../repositories'
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

/** What a customer session carries (identity only): the phone and/or the verified e-mail it signs in with. */
export interface CustomerSessionUser { id: string, organizationId: string, phone: string | null, email: string | null, fullName: string, sessionVersion: number, isNew: boolean }


/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof accountsRepos>[0]

async function tenantFor(db: Db, organizationSlug: string) {
  const tenant = await resolveTenantBySlug(db, organizationSlug)
  if (!tenant) throw new ValidationError('INVALID_REFERENCE', 'Unknown organization')
  return tenant
}

const invalidCode = () => new UnauthenticatedError('OTP_INVALID', 'The code is not valid or has expired')

/** How a code travels: by SMS to a phone, or by e-mail to an address (D-P2-68). */
type Channel = 'sms' | 'email'
const channelOf = (destination: OtpDestination): Channel => ('email' in destination ? 'email' : 'sms')

/**
 * A channel's own limits: per client address (on top of `otpRequestPerIp`); the resend cooldown and requests per
 * destination, then per destination and client address, then per destination again (a higher total); verifications.
 */
interface ChannelLimits {
  fromClientAddress: readonly RateLimitPolicy[]
  cooldown: RateLimitPolicy
  requests: readonly RateLimitPolicy[]
  requestsFromClientAddress: readonly RateLimitPolicy[]
  requestsTotal: readonly RateLimitPolicy[]
  verifyFromAddress: RateLimitPolicy
  verifyTotal: RateLimitPolicy
}

/**
 * E-mail adds daily caps per client address, and per mailbox split like the verification limits — per (mailbox,
 * client address), then a higher total — so a stranger cannot shut the owner out for a day cheaply (D-P2-68).
 */
const CHANNEL_LIMITS: Record<Channel, ChannelLimits> = {
  sms: {
    fromClientAddress: [],
    cooldown: RATE_LIMITS.otpResendCooldown,
    requests: [RATE_LIMITS.otpRequestPerPhone],
    requestsFromClientAddress: [],
    requestsTotal: [],
    verifyFromAddress: RATE_LIMITS.otpVerifyPerPhone,
    verifyTotal: RATE_LIMITS.otpVerifyPerPhoneTotal,
  },
  email: {
    fromClientAddress: [RATE_LIMITS.otpEmailRequestPerIp, RATE_LIMITS.otpEmailRequestPerIpDay],
    cooldown: RATE_LIMITS.otpEmailResendCooldown,
    requests: [RATE_LIMITS.otpRequestPerEmail],
    requestsFromClientAddress: [RATE_LIMITS.otpRequestPerEmailFromAddressDay],
    requestsTotal: [RATE_LIMITS.otpRequestPerEmailDayTotal],
    verifyFromAddress: RATE_LIMITS.otpVerifyPerEmail,
    verifyTotal: RATE_LIMITS.otpVerifyPerEmailTotal,
  },
}

/**
 * The rate-limit subject of a destination within the organization (a phone's is unchanged since D-P2-27); an address
 * counts as its mailbox, its aliases included.
 */
const destinationKey = (scope: OrganizationScope, destination: OtpDestination) => `${scope.organizationId}\u0000${'email' in destination ? emailLimitSubject(destination.email) : destination.phone}`

/** The organization's budget per channel (env-configurable): per hour, and per day, with an operator alert in the log. */
function deliveryBudget(channel: Channel): RateLimitPolicy[] {
  const env = getEnv()
  const budget = channel === 'email'
    ? { name: 'otp-email-org', hourly: env.EMAIL_HOURLY_LIMIT, daily: env.EMAIL_DAILY_LIMIT }
    : { name: 'otp-org', hourly: env.SMS_HOURLY_LIMIT, daily: env.SMS_DAILY_LIMIT }
  return [
    { name: `${budget.name}-hour`, limit: budget.hourly, windowSeconds: 60 * 60 },
    { name: `${budget.name}-day`, limit: budget.daily, windowSeconds: 24 * 60 * 60 },
  ]
}

async function consumeDeliveryBudget(db: Db, channel: Channel, organizationId: string, now: Date): Promise<void> {
  for (const policy of deliveryBudget(channel)) {
    await consumeRateLimit(db, policy, organizationId, now).catch((error: unknown) => {
      console.warn(`[${channel}] organization ${organizationId} reached its ${policy.name} ${channel === 'email' ? 'e-mail' : 'SMS'} budget`)
      throw error
    })
  }
}

/** SMS-pumping guard: only the configured countries (calling codes) receive codes. */
function assertSupportedDestination(phone: string): void {
  if (!getEnv().SMS_ALLOWED_CALLING_CODES.some(code => phone.startsWith(`+${code}`))) {
    throw new ValidationError('PHONE_NOT_SUPPORTED', 'Sign-in codes cannot be sent to this country')
  }
}

/** The sign-in e-mail: the code, how long it is valid and the site's name — no other personal data. */
function signInCodeEmail(to: string, code: string, siteName: string): EmailMessage {
  return composeEmail(to, 'Your sign-in code', [
    `Your sign-in code for ${siteName}:`,
    { strong: code },
    `It expires in ${OTP_TTL_SECONDS / 60} minutes. Do not share it with anyone.`,
    'If you did not ask for this code, you can ignore this e-mail.',
  ])
}

/** Sends the code: a text message, or an e-mail naming the site (the sender's name in EMAIL_FROM, else the organization's). */
async function deliverCode(destination: OtpDestination, code: string, organizationName: string): Promise<void> {
  if ('email' in destination) return useEmailSender().send(signInCodeEmail(destination.email, code, getEnv().EMAIL_FROM?.name ?? organizationName))
  return useSmsSender().send({ to: destination.phone, text: `Your verification code is ${code}. It expires in ${OTP_TTL_SECONDS / 60} minutes. Do not share it.` })
}

/**
 * Sends a sign-in code (v7 §21: phone OTP for the public site; D-P2-68: or e-mail; sign-up and sign-in are the same
 * flow), to the phone or the e-mail address given. Before anything is created or sent: a phone's country must be
 * allowed, the bot check pass (when configured), and the limits hold — per client address (both channels, and fewer
 * e-mails an hour and a day), one code per destination per minute, 3 per destination per 15 minutes (and per mailbox 5
 * a day from one client address and 30 from all, an address's aliases counting as the address), and the
 * organization's hourly and daily budget of the channel. The answer is the same whether or not the destination has an account. A new code closes the destination's
 * older ones once it is sent (a failed send leaves them usable); only a hash of the code is stored.
 */
export async function requestCustomerOtp(input: OtpRequestInput, request: LoginRequest): Promise<OtpChallengeIssued> {
  const db = useDb()
  const destination: OtpDestination = 'email' in input ? { email: input.email } : { phone: input.phone }
  const channel = channelOf(destination)
  if ('phone' in destination) assertSupportedDestination(destination.phone)
  const limits = CHANNEL_LIMITS[channel]
  await consumeRateLimit(db, RATE_LIMITS.otpRequestPerIp, request.clientIp, request.now)
  for (const policy of limits.fromClientAddress) await consumeRateLimit(db, policy, request.clientIp, request.now)
  await assertHuman(input.captchaToken, request.clientIp)
  const { organization, scope } = await tenantFor(db, input.organizationSlug)
  const key = destinationKey(scope, destination)
  await consumeRateLimit(db, limits.cooldown, key, request.now)
  for (const policy of limits.requests) await consumeRateLimit(db, policy, key, request.now)
  // The pair before the total: a client address refused at its own cap adds nothing to the mailbox's total.
  for (const policy of limits.requestsFromClientAddress) await consumeRateLimit(db, policy, `${key}\u0000${request.clientIp}`, request.now)
  for (const policy of limits.requestsTotal) await consumeRateLimit(db, policy, key, request.now)
  await consumeDeliveryBudget(db, channel, scope.organizationId, request.now)

  const challengeId = randomUUID()
  const code = generateOtpCode()
  const challenges = accountsRepos(db, scope).otpChallenges
  await challenges.insert({ id: challengeId, ...destination, codeHash: hashOtpCode(challengeId, code), expiresAt: new Date(request.now.getTime() + OTP_TTL_SECONDS * 1000) })
  await deliverCode(destination, code, organization.name)
  await challenges.closeOpenFor(destination, request.now, challengeId)
  return { challengeId, expiresInSeconds: OTP_TTL_SECONDS }
}

/** Where a challenge's code went (the database holds exactly one of the two). */
const destinationOf = (challenge: OtpChallengeRow): OtpDestination => (challenge.email !== null ? { email: challenge.email } : { phone: challenge.phone! })

/** The new account a first sign-in creates: the proven phone or e-mail, verified now (never both: D-P2-68). */
function newCustomer(destination: OtpDestination, fullName: string, now: Date) {
  return 'email' in destination ? { email: destination.email, emailVerifiedAt: now, fullName } : { phone: destination.phone, phoneVerifiedAt: now, fullName }
}

/** The session's identity: the phone and the verified e-mail the account signs in with (one may be null). */
const sessionUserOf = (row: CustomerRow, isNew: boolean): CustomerSessionUser => ({
  id: row.id, organizationId: row.organizationId, phone: row.phone, email: verifiedEmailOf(row), fullName: row.fullName, sessionVersion: row.sessionVersion, isNew,
})

/**
 * Checks a code and signs the customer in, creating the account on first use (a new customer must give a name:
 * 422 `FULL_NAME_REQUIRED`, the challenge stays usable). The account is the one that signs in with the code's phone
 * or verified e-mail: a phone account and an e-mail account are never linked (D-P2-68). Every check counts an attempt
 * atomically (at most OTP_MAX_ATTEMPTS per challenge), plus limits per client address, per destination and address,
 * and (higher) per destination across challenges; unknown, expired, used and wrong codes all answer 401 `OTP_INVALID`.
 * Consuming the code, creating the customer and recording the sign-in are one transaction: a refusal after the code
 * check leaves the code usable.
 */
export async function verifyCustomerOtp(input: OtpVerifyInput, request: LoginRequest): Promise<CustomerSessionUser> {
  const db = useDb()
  await consumeRateLimit(db, RATE_LIMITS.otpVerifyPerIp, request.clientIp, request.now)
  const { scope } = await tenantFor(db, input.organizationSlug)

  const challenge = await accountsRepos(db, scope).otpChallenges.registerAttempt(input.challengeId, request.now, OTP_MAX_ATTEMPTS)
  if (!challenge) throw invalidCode()
  const destination = destinationOf(challenge)
  const limits = CHANNEL_LIMITS[channelOf(destination)]
  const key = destinationKey(scope, destination)
  const addressKey = `${key}\u0000${request.clientIp}`
  await consumeRateLimit(db, limits.verifyFromAddress, addressKey, request.now)
  await consumeRateLimit(db, limits.verifyTotal, key, request.now)
  if (!otpCodeMatches(challenge.id, input.code, challenge.codeHash)) throw invalidCode()

  const signedIn = await db.transaction(async (tx) => {
    const repos = accountsRepos(tx, scope)
    if (!await repos.otpChallenges.consume(challenge.id, request.now)) throw invalidCode()
    const existing = 'email' in destination ? await repos.customers.findByVerifiedEmail(destination.email) : await repos.customers.findByPhone(destination.phone)
    if (!existing && !input.fullName) throw new ValidationError('FULL_NAME_REQUIRED', 'Tell us your name to create your account')
    if (existing && !existing.isActive) throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled')
    const customerRow = existing ?? await repos.customers.insert(newCustomer(destination, input.fullName!, request.now))
    await repos.customers.recordLogin(customerRow.id, request.now)
    return { customerRow, isNew: !existing }
  }).catch(rethrowDbError)

  await clearRateLimit(db, limits.verifyFromAddress, addressKey)
  await clearRateLimit(db, limits.verifyTotal, key)
  return sessionUserOf(signedIn.customerRow, signedIn.isNew)
}

/** "Sign out everywhere": ends every session of the customer (the caller's included). */
export async function signOutEverywhere(ctx: CustomerContext): Promise<void> {
  await accountsRepos(ctx.db, ctx.scope).customers.bumpSessionVersion(ctx.identity.customerId)
}

export function getCustomerMe(ctx: CustomerContext): CustomerMe {
  return { id: ctx.identity.customerId, phone: ctx.identity.phone, email: ctx.identity.email, fullName: ctx.identity.fullName }
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
