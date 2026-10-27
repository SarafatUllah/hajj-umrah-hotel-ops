import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { customer, otpChallenge } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import { otpRequestSchema } from '@hajj/contracts/schemas/customer'
import { extractPgError } from '../../../server/errors/dbErrors'
import { accountsRepos, platformRepos } from '../../../server/repositories'
import { bucketKey, RATE_LIMITS, windowStartFor, type RateLimitPolicy } from '../../../server/security/rateLimit'
import { TooManyRequestsError } from '../../../server/errors/domainError'
import { setEmailSenderForTests, type EmailMessage } from '../../../server/notifications/email'
import { setSmsSenderForTests, type SmsMessage } from '../../../server/notifications/sms'
import { resolveCustomerContext } from '../../../server/security/customerContext'
import { closeCustomerRecord, getCustomerMe, requestCustomerOtp, verifyCustomerOtp } from '../../../server/services/accounts'
import { getEnv, resetEnvCache } from '../../../server/utils/env'
import { makeOrg } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
let emails: EmailMessage[] = []
let texts: SmsMessage[] = []
let ipSequence = 0
const request = (clientIp = `198.51.100.${++ipSequence % 250}`, now = new Date()) => ({ clientIp, now })
let addressSequence = 0
const newAddress = () => `pilgrim${++addressSequence}@example.test`

beforeEach(() => {
  emails = []
  texts = []
  setEmailSenderForTests({ send: async (m) => { emails.push(m) } })
  setSmsSenderForTests({ send: async (m) => { texts.push(m) } })
})

afterEach(async () => {
  setEmailSenderForTests(null)
  setSmsSenderForTests(null)
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

/** The code: its own line of the e-mail (the organization's name in the first line may hold digits too). */
const codeIn = (message: EmailMessage | undefined) => /^(\d{6})$/m.exec(message?.text ?? '')![1]!

/** Asks for a code by e-mail as the public site does (the body through the shared schema: trimmed, lower-cased). */
async function issue(slug: string, email = newAddress(), minutesLater = 0, from = Date.now()) {
  const input = otpRequestSchema.parse({ organizationSlug: slug, email })
  const issued = await requestCustomerOtp(input, request(undefined, new Date(from + minutesLater * 61_000)))
  return { ...issued, email: 'email' in input ? input.email : '', code: codeIn(emails.at(-1)) }
}

const verify = (slug: string, c: { challengeId: string, code: string }, fullName?: string, clientIp?: string) =>
  verifyCustomerOtp({ organizationSlug: slug, challengeId: c.challengeId, code: c.code, ...(fullName ? { fullName } : {}) }, request(clientIp))

/** Spends a limit's whole window (the one holding `at`) for one subject, as earlier requests would have. */
async function exhaust(policy: RateLimitPolicy, subject: string, at = new Date()) {
  const key = bucketKey(policy, subject)
  for (let i = 0; i < policy.limit; i++) await platformRepos(db).rateLimits.hit(key, windowStartFor(policy, at))
}

describe('customer sign-in by e-mail code (D-P2-68)', () => {
  it('e-mails a six-digit code with the site\'s name and its validity — nothing else — and stores only its hash', async () => {
    const { organization } = await makeOrg(db)
    const { challengeId, code, email, expiresInSeconds } = await issue(organization.slug)

    expect(expiresInSeconds).toBe(300)
    expect(texts).toEqual([])
    expect(emails).toHaveLength(1)
    const [sent] = emails
    expect(sent).toMatchObject({ to: email, subject: 'Your sign-in code' })
    expect(sent!.text).toBe(`Your sign-in code for ${organization.name}:\n\n${code}\n\nIt expires in 5 minutes. Do not share it with anyone.\n\nIf you did not ask for this code, you can ignore this e-mail.`)
    expect(sent!.html).toContain(`>${code}</p>`)
    const [row] = await db.select().from(otpChallenge).where(eq(otpChallenge.id, challengeId))
    expect(row).toMatchObject({ email, phone: null })
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('the address is normalized: any case and spaces reach the same account', async () => {
    const { organization } = await makeOrg(db)
    const first = await issue(organization.slug, '  Aisha.Rahman@Example.TEST ')
    expect(first.email).toBe('aisha.rahman@example.test')
    expect(emails[0]!.to).toBe('aisha.rahman@example.test')
    const created = await verify(organization.slug, first, 'Aisha Rahman')
    expect(created).toMatchObject({ isNew: true, email: 'aisha.rahman@example.test', phone: null, fullName: 'Aisha Rahman' })

    const again = await issue(organization.slug, 'AISHA.RAHMAN@example.test', 1)
    expect(await verify(organization.slug, again)).toMatchObject({ isNew: false, id: created.id })
    const [row] = await db.select().from(customer).where(eq(customer.id, created.id))
    expect(row).toMatchObject({ email: 'aisha.rahman@example.test', emailVerifiedAt: expect.any(Date), phone: null, phoneVerifiedAt: null, lastLoginAt: expect.any(Date) })
  })

  it('first use needs a name (422, the code stays usable); wrong and reused codes are 401 OTP_INVALID', async () => {
    const { organization } = await makeOrg(db)
    const first = await issue(organization.slug)
    await expect(verify(organization.slug, first)).rejects.toMatchObject({ code: 'FULL_NAME_REQUIRED', httpStatus: 422 })
    await expect(verify(organization.slug, { ...first, code: first.code === '000000' ? '000001' : '000000' }, 'X')).rejects.toMatchObject({ code: 'OTP_INVALID', httpStatus: 401 })
    await verify(organization.slug, first, 'Omar')
    await expect(verify(organization.slug, first, 'Omar')).rejects.toMatchObject({ code: 'OTP_INVALID' })
  })

  it('an e-mail account and a phone account are separate customers: nothing links them', async () => {
    const { organization, scope } = await makeOrg(db)
    const byEmail = await verify(organization.slug, await issue(organization.slug, 'omar@example.test'), 'Omar Farooq')
    await requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, phone: '+966501112233' }), request())
    const phoneCode = /(\d{6})/.exec(texts.at(-1)!.text)![1]!
    const [phoneChallenge] = await db.select().from(otpChallenge).where(eq(otpChallenge.phone, '+966501112233'))
    const byPhone = await verify(organization.slug, { challengeId: phoneChallenge!.id, code: phoneCode }, 'Omar Farooq')

    expect(byPhone.id).not.toBe(byEmail.id)
    expect(byPhone).toMatchObject({ isNew: true, phone: '+966501112233', email: null })
    const ctx = (await resolveCustomerContext(db as Database, { customerId: byEmail.id, organizationId: scope.organizationId, sessionVersion: 1 }))!
    expect(getCustomerMe(ctx)).toEqual({ id: byEmail.id, phone: null, email: 'omar@example.test', fullName: 'Omar Farooq' })
  })

  it('a verified address is unique in an organization (the database refuses a second one); an unverified copy or another organization is not', async () => {
    const a = await makeOrg(db)
    const b = await makeOrg(db)
    const now = new Date()
    await accountsRepos(db, a.scope).customers.insert({ email: 'dup@example.test', emailVerifiedAt: now, fullName: 'First' })
    const duplicate = await accountsRepos(db, a.scope).customers.insert({ email: 'dup@example.test', emailVerifiedAt: now, fullName: 'Second' }).catch((error: unknown) => error)
    expect(extractPgError(duplicate)).toMatchObject({ code: '23505', constraint: 'customer_org_verified_email_unique' })
    await accountsRepos(db, a.scope).customers.insert({ phone: '+966501234500', email: 'dup@example.test', fullName: 'Contact only' })
    await accountsRepos(db, b.scope).customers.insert({ email: 'dup@example.test', emailVerifiedAt: now, fullName: 'Elsewhere' })
  })

  it('two open codes for one new address verified at once never make two accounts', async () => {
    const { organization } = await makeOrg(db)
    const email = newAddress()
    const first = await issue(organization.slug, email)
    // A second code still open next to the first (as two tabs racing a resend would have it): moved onto the address.
    const second = await issue(organization.slug)
    await db.update(otpChallenge).set({ email }).where(eq(otpChallenge.id, second.challengeId))
    const results = await Promise.allSettled([verify(organization.slug, first, 'A'), verify(organization.slug, second, 'A')])
    // Whichever commits second either finds the new account or loses on the unique index (409, its code still usable).
    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ httpStatus: 409 })
    expect(await db.select().from(customer).where(eq(customer.email, email))).toHaveLength(1)
  })

  it('one code per address per minute and 3 per 15 minutes; a new code closes the older ones', async () => {
    const { organization } = await makeOrg(db)
    const email = newAddress()
    const windowStart = Math.ceil(Date.now() / 900_000) * 900_000
    const first = await issue(organization.slug, email, 0, windowStart)
    await expect(requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, email }), request(undefined, new Date(windowStart)))).rejects.toBeInstanceOf(TooManyRequestsError)
    const second = await issue(organization.slug, email, 1, windowStart)
    await issue(organization.slug, email, 2, windowStart)
    await expect(requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, email }), request(undefined, new Date(windowStart + 3 * 61_000)))).rejects.toBeInstanceOf(TooManyRequestsError)
    for (const older of [first, second]) await expect(verify(organization.slug, older, 'X')).rejects.toMatchObject({ code: 'OTP_INVALID' })
  })

  it('an address\'s aliases share its counts (a +tag, Gmail\'s dots): its inbox cannot be flooded through them', async () => {
    const { organization } = await makeOrg(db)
    const windowStart = Math.ceil(Date.now() / 900_000) * 900_000
    await issue(organization.slug, 'a.isha+1@gmail.com', 0, windowStart)
    await expect(issue(organization.slug, 'aisha+2@gmail.com', 0, windowStart)).rejects.toBeInstanceOf(TooManyRequestsError)
    await issue(organization.slug, 'aisha+2@googlemail.com', 1, windowStart)
    await issue(organization.slug, 'AISHA@gmail.com', 2, windowStart)
    await expect(issue(organization.slug, 'ai.sha+4@gmail.com', 3, windowStart)).rejects.toBeInstanceOf(TooManyRequestsError)
    // Each alias is still its own address: the codes went where they were asked for.
    expect(emails.map(e => e.to)).toEqual(['a.isha+1@gmail.com', 'aisha+2@googlemail.com', 'aisha@gmail.com'])
  })

  it('one client address may ask for only so many e-mailed codes an hour and a day, each below the organization\'s budget for that window; phones are not counted', async () => {
    const { organization } = await makeOrg(db)
    const env = getEnv()
    const caps = [
      { policy: RATE_LIMITS.otpEmailRequestPerIp, windowSeconds: 60 * 60, budget: env.EMAIL_HOURLY_LIMIT, clientIp: '203.0.113.80', phone: '+966501112255' },
      { policy: RATE_LIMITS.otpEmailRequestPerIpDay, windowSeconds: 24 * 60 * 60, budget: env.EMAIL_DAILY_LIMIT, clientIp: '203.0.113.81', phone: '+966501112256' },
    ]
    for (const { policy, windowSeconds, budget, clientIp, phone } of caps) {
      // One client address alone, however many throwaway addresses it rotates, cannot spend the window's budget.
      expect(policy.windowSeconds, policy.name).toBe(windowSeconds)
      expect(policy.limit, policy.name).toBeLessThan(budget)
      await exhaust(policy, clientIp)
      await expect(requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, email: newAddress() }), request(clientIp)), policy.name).rejects.toBeInstanceOf(TooManyRequestsError)
      await expect(requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, phone }), request(clientIp)), policy.name).resolves.toMatchObject({ expiresInSeconds: 300 })
    }
    expect(emails).toEqual([])
  })

  it('one client address gets only so many codes a day to one mailbox (aliases included); the mailbox\'s owner, elsewhere, still gets theirs', async () => {
    const { organization, scope } = await makeOrg(db)
    const pair = RATE_LIMITS.otpRequestPerEmailFromAddressDay
    expect(pair).toMatchObject({ limit: 5, windowSeconds: 24 * 60 * 60 })
    // The start of a UTC day: every window of these requests (minute, 15 minutes, day) begins there.
    const day = Math.ceil(Date.now() / 86_400_000) * 86_400_000
    const [stranger, owner] = ['203.0.113.90', '198.51.100.90']
    const ask = (email: string, clientIp: string, minutesLater: number) => requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, email }), request(clientIp, new Date(day + minutesLater * 61_000)))
    await exhaust(pair, `${scope.organizationId}\u0000aisha@gmail.com\u0000${stranger}`, new Date(day))

    await expect(ask('a.isha+9@gmail.com', stranger, 0)).rejects.toBeInstanceOf(TooManyRequestsError)
    await expect(ask('aisha@gmail.com', owner, 1)).resolves.toMatchObject({ expiresInSeconds: 300 })
    expect(emails.map(e => e.to)).toEqual(['aisha@gmail.com'])
  })

  it('one mailbox gets at most 30 codes a day from every client address together — a botnet\'s bound, far above what one address may ask', async () => {
    const { organization, scope } = await makeOrg(db)
    const total = RATE_LIMITS.otpRequestPerEmailDayTotal
    expect(total).toMatchObject({ limit: 30, windowSeconds: 24 * 60 * 60 })
    // Filling it needs at least 6 client addresses (and 30 solved bot checks).
    expect(total.limit / RATE_LIMITS.otpRequestPerEmailFromAddressDay.limit).toBeGreaterThanOrEqual(6)
    await exhaust(total, `${scope.organizationId}\u0000aisha@gmail.com`)
    await expect(issue(organization.slug, 'aisha@googlemail.com')).rejects.toBeInstanceOf(TooManyRequestsError)
    expect(emails).toEqual([])
    await expect(issue(organization.slug, 'omar@example.test')).resolves.toMatchObject({ expiresInSeconds: 300 })
  })

  it('verifications of one address are limited per client address (a stranger never locks the owner out) and in total (429)', async () => {
    const { organization, scope } = await makeOrg(db)
    const issued = await issue(organization.slug)
    const [stranger, owner] = ['203.0.113.66', '198.51.100.7']
    await exhaust(RATE_LIMITS.otpVerifyPerEmail, `${scope.organizationId}\u0000${issued.email}\u0000${stranger}`)
    await expect(verify(organization.slug, issued, 'X', stranger)).rejects.toBeInstanceOf(TooManyRequestsError)
    await expect(verify(organization.slug, issued, 'X', owner)).resolves.toMatchObject({ email: issued.email })

    const next = await issue(organization.slug, issued.email, 1)
    await exhaust(RATE_LIMITS.otpVerifyPerEmailTotal, `${scope.organizationId}\u0000${issued.email}`)
    await expect(verify(organization.slug, next, undefined, owner)).rejects.toBeInstanceOf(TooManyRequestsError)
    expect(RATE_LIMITS.otpVerifyPerEmailTotal.limit).toBeGreaterThan(RATE_LIMITS.otpVerifyPerEmail.limit)
  })

  it('the organization\'s e-mail budget refuses more codes (429, logged); the SMS budget is its own', async () => {
    const { organization, scope } = await makeOrg(db)
    const hour = { name: 'otp-email-org-hour', limit: 100, windowSeconds: 60 * 60 }
    const key = bucketKey(hour, scope.organizationId)
    for (let i = 0; i < hour.limit; i++) await platformRepos(db).rateLimits.hit(key, windowStartFor(hour, new Date()))
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(issue(organization.slug)).rejects.toBeInstanceOf(TooManyRequestsError)
    expect(warned).toHaveBeenCalledWith(`[email] organization ${scope.organizationId} reached its otp-email-org-hour e-mail budget`)
    expect(emails).toEqual([])
    await expect(requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, phone: '+966501112244' }), request())).resolves.toMatchObject({ expiresInSeconds: 300 })
    warned.mockRestore()
  })

  it('the bot check guards the e-mail request too (CAPTCHA_DRIVER=turnstile: 422 CAPTCHA_FAILED before anything is sent)', async () => {
    const { organization } = await makeOrg(db)
    const saved = { CAPTCHA_DRIVER: process.env.CAPTCHA_DRIVER, CAPTCHA_SECRET: process.env.CAPTCHA_SECRET }
    Object.assign(process.env, { CAPTCHA_DRIVER: 'turnstile', CAPTCHA_SECRET: 'turnstile-secret' })
    resetEnvCache()
    try {
      await expect(issue(organization.slug)).rejects.toMatchObject({ code: 'CAPTCHA_FAILED', httpStatus: 422 })
      expect(emails).toEqual([])
      expect(await db.select().from(otpChallenge)).toEqual([])
    }
    finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      resetEnvCache()
    }
  })

  it('no e-mail provider is 503 EMAIL_UNAVAILABLE; a failed e-mail leaves the previous code usable', async () => {
    const { organization } = await makeOrg(db)
    const first = await issue(organization.slug)
    setEmailSenderForTests({ send: async () => { throw new Error('smtp down') } })
    await expect(requestCustomerOtp(otpRequestSchema.parse({ organizationSlug: organization.slug, email: first.email }), request(undefined, new Date(Date.now() + 61_000)))).rejects.toThrow('smtp down')
    await expect(verify(organization.slug, first, 'X')).resolves.toMatchObject({ email: first.email })

    setEmailSenderForTests(null) // .env.test leaves EMAIL_DRIVER unset: disabled
    await expect(issue(organization.slug)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', httpStatus: 503 })
  })

  it('closing an e-mail account clears the address and its verification: the address may sign up again as a new account', async () => {
    const { organization, scope } = await makeOrg(db)
    const first = await issue(organization.slug)
    const created = await verify(organization.slug, first, 'Fatima')
    await closeCustomerRecord(db, scope, created.id, new Date())

    const [closed] = await db.select().from(customer).where(eq(customer.id, created.id))
    expect(closed).toMatchObject({ email: null, emailVerifiedAt: null, phone: null, isActive: false, closedAt: expect.any(Date) })
    expect(await resolveCustomerContext(db as Database, { customerId: created.id, organizationId: scope.organizationId })).toBeNull()
    const again = await issue(organization.slug, first.email, 1)
    const reborn = await verify(organization.slug, again, 'Fatima')
    expect(reborn).toMatchObject({ isNew: true, email: first.email })
    expect(reborn.id).not.toBe(created.id)
  })
})
