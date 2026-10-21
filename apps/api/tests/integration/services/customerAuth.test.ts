import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { customer, otpChallenge } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import { OTP_MAX_ATTEMPTS } from '@hajj/contracts/constants/accounts'
import { platformRepos } from '../../../server/repositories'
import { bucketKey, RATE_LIMITS, windowStartFor } from '../../../server/security/rateLimit'
import { TooManyRequestsError } from '../../../server/errors/domainError'
import { securityCleanupJob } from '../../../server/jobs/securityJobs'
import { setSmsSenderForTests, type SmsMessage } from '../../../server/notifications/sms'
import { resolveCustomerContext } from '../../../server/security/customerContext'
import { getCustomerMe, requestCustomerOtp, signOutEverywhere, verifyCustomerOtp } from '../../../server/services/accounts'
import { makeOrg } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
let sent: SmsMessage[] = []
let ipSequence = 0
const request = (clientIp = `198.51.100.${++ipSequence % 250}`, now = new Date()) => ({ clientIp, now })
let phoneSequence = 0
const newPhone = () => `+9665${String(++phoneSequence).padStart(8, '0')}`

beforeEach(() => {
  sent = []
  setSmsSenderForTests({ send: async (m) => { sent.push(m) } })
})

afterEach(async () => {
  setSmsSenderForTests(null)
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const codeIn = (message: SmsMessage | undefined) => /(\d{6})/.exec(message?.text ?? '')![1]!

/** Issues a code (`minutesLater` keeps repeated requests for one phone past the one-per-minute cooldown). */
async function issue(slug: string, phone = newPhone(), minutesLater = 0, from = Date.now()) {
  const issued = await requestCustomerOtp({ organizationSlug: slug, phone }, request(undefined, new Date(from + minutesLater * 61_000)))
  return { ...issued, phone, code: codeIn(sent.at(-1)) }
}

describe('customer sign-in by SMS code', () => {
  it('texts a six-digit code and stores only its hash', async () => {
    const { organization } = await makeOrg(db)
    const { challengeId, code, phone, expiresInSeconds } = await issue(organization.slug)

    expect(expiresInSeconds).toBe(300)
    expect(sent).toEqual([{ to: phone, text: expect.stringContaining(code) }])
    const [row] = await db.select().from(otpChallenge).where(eq(otpChallenge.id, challengeId))
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('first use: a name is required (422, the code stays usable), then the account is created; later sign-ins find it', async () => {
    const { organization } = await makeOrg(db)
    const first = await issue(organization.slug)
    const verify = (fullName?: string, c = first) => verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: c.challengeId, code: c.code, ...(fullName ? { fullName } : {}) }, request())

    await expect(verify()).rejects.toMatchObject({ code: 'FULL_NAME_REQUIRED', httpStatus: 422 })
    const created = await verify('Aisha Rahman')
    expect(created).toMatchObject({ isNew: true, phone: first.phone, fullName: 'Aisha Rahman', sessionVersion: 1 })

    const again = await issue(organization.slug, first.phone, 1)
    expect(await verify(undefined, again)).toMatchObject({ isNew: false, id: created.id })
    const [row] = await db.select().from(customer).where(eq(customer.id, created.id))
    expect(row).toMatchObject({ phoneVerifiedAt: expect.any(Date), lastLoginAt: expect.any(Date) })
  })

  it('wrong, used, expired and exhausted codes all answer 401 OTP_INVALID', async () => {
    const { organization } = await makeOrg(db)
    const slug = organization.slug
    const verify = (c: { challengeId: string }, code: string, now = new Date()) => verifyCustomerOtp({ organizationSlug: slug, challengeId: c.challengeId, code, fullName: 'X' }, request(undefined, now))

    const used = await issue(slug)
    await verify(used, used.code)
    await expect(verify(used, used.code)).rejects.toMatchObject({ code: 'OTP_INVALID', httpStatus: 401 })

    const expired = await issue(slug)
    await expect(verify(expired, expired.code, new Date(Date.now() + 301_000))).rejects.toMatchObject({ code: 'OTP_INVALID' })

    const guessed = await issue(slug)
    const wrong = guessed.code === '000000' ? '000001' : '000000'
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) await expect(verify(guessed, wrong)).rejects.toMatchObject({ code: 'OTP_INVALID' })
    await expect(verify(guessed, guessed.code)).rejects.toMatchObject({ code: 'OTP_INVALID' })

    await expect(verify({ challengeId: '00000000-0000-4000-8000-000000000000' }, '123456')).rejects.toMatchObject({ code: 'OTP_INVALID' })
  })

  it('parallel guesses never exceed the attempt limit; parallel correct codes sign in exactly once', async () => {
    const { organization } = await makeOrg(db)
    const guessed = await issue(organization.slug)
    const guesses = Array.from({ length: 12 }, (_, i) => String(i).padStart(6, '9')).filter(c => c !== guessed.code)
    await Promise.allSettled(guesses.map(code => verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: guessed.challengeId, code, fullName: 'X' }, request())))
    const [row] = await db.select().from(otpChallenge).where(eq(otpChallenge.id, guessed.challengeId))
    expect(row!.attempts).toBe(OTP_MAX_ATTEMPTS)

    const right = await issue(organization.slug)
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: right.challengeId, code: right.code, fullName: 'X' }, request())))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(await db.select().from(customer).where(eq(customer.phone, right.phone))).toHaveLength(1)
  })

  it('a code of one organization is useless in another', async () => {
    const a = await makeOrg(db)
    const b = await makeOrg(db)
    const issued = await issue(a.organization.slug)
    await expect(verifyCustomerOtp({ organizationSlug: b.organization.slug, challengeId: issued.challengeId, code: issued.code, fullName: 'X' }, request())).rejects.toMatchObject({ code: 'OTP_INVALID' })
  })

  it('one code per phone per minute and 3 per 15 minutes; a new code closes the older ones', async () => {
    const { organization } = await makeOrg(db)
    const phone = newPhone()
    // The limits are fixed 15-minute windows: start the requests at the beginning of one, so the four of them
    // (three minutes apart at most) never straddle a boundary whatever the time the suite runs.
    const windowStart = Math.ceil(Date.now() / 900_000) * 900_000
    const first = await issue(organization.slug, phone, 0, windowStart)
    await expect(requestCustomerOtp({ organizationSlug: organization.slug, phone }, request(undefined, new Date(windowStart)))).rejects.toBeInstanceOf(TooManyRequestsError)
    const second = await issue(organization.slug, phone, 1, windowStart)
    await issue(organization.slug, phone, 2, windowStart)
    await expect(requestCustomerOtp({ organizationSlug: organization.slug, phone }, request(undefined, new Date(windowStart + 3 * 61_000)))).rejects.toBeInstanceOf(TooManyRequestsError)

    for (const older of [first, second]) {
      await expect(verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: older.challengeId, code: older.code, fullName: 'X' }, request())).rejects.toMatchObject({ code: 'OTP_INVALID' })
    }
  })

  it('refuses countries outside SMS_ALLOWED_CALLING_CODES (422) before any SMS; an unknown organization is 422; no SMS gateway is 503', async () => {
    const { organization } = await makeOrg(db)
    await expect(requestCustomerOtp({ organizationSlug: organization.slug, phone: '+88017000000001' }, request())).rejects.toMatchObject({ code: 'PHONE_NOT_SUPPORTED', httpStatus: 422 })
    expect(sent).toEqual([])
    await expect(requestCustomerOtp({ organizationSlug: 'no-such-org', phone: newPhone() }, request())).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })

    setSmsSenderForTests(null) // .env.test leaves SMS_DRIVER unset: disabled
    await expect(requestCustomerOtp({ organizationSlug: organization.slug, phone: newPhone() }, request())).rejects.toMatchObject({ code: 'SMS_UNAVAILABLE', httpStatus: 503 })
  })

  it('verifications of one phone from one address are limited across challenges (429); a stranger elsewhere never locks the owner out', async () => {
    const { organization, scope } = await makeOrg(db)
    const issued = await issue(organization.slug)
    const [stranger, owner] = ['203.0.113.66', '198.51.100.7']
    const key = bucketKey(RATE_LIMITS.otpVerifyPerPhone, `${scope.organizationId}\u0000${issued.phone}\u0000${stranger}`)
    for (let i = 0; i < RATE_LIMITS.otpVerifyPerPhone.limit; i++) await platformRepos(db).rateLimits.hit(key, windowStartFor(RATE_LIMITS.otpVerifyPerPhone, new Date()))
    const verifyFrom = (clientIp: string) => verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: issued.challengeId, code: issued.code, fullName: 'X' }, request(clientIp))
    await expect(verifyFrom(stranger)).rejects.toBeInstanceOf(TooManyRequestsError)
    await expect(verifyFrom(owner)).resolves.toMatchObject({ phone: issued.phone })
  })

  it('sign out everywhere ends every session of the customer', async () => {
    const { organization, scope } = await makeOrg(db)
    const issued = await issue(organization.slug)
    const created = await verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: issued.challengeId, code: issued.code, fullName: 'Omar' }, request())
    const identity = { customerId: created.id, organizationId: scope.organizationId, sessionVersion: 1 }
    await signOutEverywhere((await resolveCustomerContext(db as Database, identity))!)
    expect(await resolveCustomerContext(db as Database, identity)).toBeNull()
  })

  it('a disabled customer proves the phone but is refused (403); the context is resolved fresh', async () => {
    const { organization, scope } = await makeOrg(db)
    const first = await issue(organization.slug)
    const created = await verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: first.challengeId, code: first.code, fullName: 'Omar' }, request())
    const identity = { customerId: created.id, organizationId: scope.organizationId, sessionVersion: 1 }

    const ctx = (await resolveCustomerContext(db as Database, identity))!
    expect(getCustomerMe(ctx)).toEqual({ id: created.id, phone: first.phone, fullName: 'Omar' })
    expect(ctx.scope).toMatchObject({ customerId: created.id })
    expect(await resolveCustomerContext(db as Database, { ...identity, sessionVersion: 2 })).toBeNull()

    await db.update(customer).set({ isActive: false }).where(eq(customer.id, created.id))
    expect(await resolveCustomerContext(db as Database, identity)).toBeNull()
    const again = await issue(organization.slug, first.phone, 1)
    await expect(verifyCustomerOtp({ organizationSlug: organization.slug, challengeId: again.challengeId, code: again.code }, request())).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED', httpStatus: 403 })
    // The refusal came after the code check, inside the sign-in transaction: the code is not used up.
    const [row] = await db.select().from(otpChallenge).where(eq(otpChallenge.id, again.challengeId))
    expect(row!.consumedAt).toBeNull()
  })

  it('the daily cleanup removes sign-in codes a day after they expired', async () => {
    const { organization } = await makeOrg(db)
    const old = await issue(organization.slug)
    const recent = await issue(organization.slug)
    await db.update(otpChallenge).set({ expiresAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(otpChallenge.id, old.challengeId))

    await securityCleanupJob.handle({}, { db: db as Database, jobId: 'test' })
    expect((await db.select().from(otpChallenge)).map(r => r.id)).toEqual([recent.challengeId])
  })
})
