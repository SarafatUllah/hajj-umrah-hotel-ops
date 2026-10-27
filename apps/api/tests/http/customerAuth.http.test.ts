import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { otpChallenge } from '@hajj/db/schema'
import { hashOtpCode } from '../../server/security/otp'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeLoginableUser, makeOrg, truncateAllTables } from './support/fixtures'
import { expectServerToFailStartup, startExtraServer } from './support/spawnServer'

const baseUrl = inject('httpTestBaseUrl')
const client = apiClient(baseUrl)
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const cookieOf = (setCookie: string[]) => setCookie.map(entry => entry.split(';')[0]).join('; ')

/**
 * The harness server sends no SMS and no e-mail (SMS_DRIVER and EMAIL_DRIVER default to disabled), so a challenge with
 * a known code is planted directly, for a phone or (D-P2-68) an e-mail address.
 */
async function plantChallenge(organizationId: string, destination: string, code = '482913') {
  const id = randomUUID()
  const sentTo = destination.includes('@') ? { email: destination } : { phone: destination }
  await db.insert(otpChallenge).values({ id, organizationId, ...sentTo, codeHash: hashOtpCode(id, code), expiresAt: new Date(Date.now() + 300_000) })
  return { challengeId: id, code }
}

describe('customer sign-in over HTTP', () => {
  it('without an SMS gateway, requesting a code is 503 SMS_UNAVAILABLE', async () => {
    const { organization } = await makeOrg(db)
    const res = await client.request('/api/customer/auth/otp/request', { method: 'POST', body: { organizationSlug: organization.slug, phone: '+966 50 123 4567' } })
    expectStandardError(res, { status: 503, code: 'SMS_UNAVAILABLE' })
  })

  it('a correct code signs a new customer up (name required) and in; me answers; logout ends it', async () => {
    const { organization } = await makeOrg(db)
    const { challengeId, code } = await plantChallenge(organization.id, '+966501234567')
    const verify = (body: Record<string, unknown>) => client.request('/api/customer/auth/otp/verify', { method: 'POST', body: { organizationSlug: organization.slug, challengeId, code, ...body } })

    expectStandardError(await verify({}), { status: 422, code: 'FULL_NAME_REQUIRED' })
    const signedIn = await verify({ fullName: 'Aisha Rahman' })
    expect(signedIn.status).toBe(200)
    expect(signedIn.json).toEqual({ customer: { id: expect.any(String), phone: '+966501234567', email: null, fullName: 'Aisha Rahman' }, isNew: true })

    const cookie = cookieOf(signedIn.setCookie)
    expect((await client.request('/api/customer/auth/me', { cookie })).json).toEqual({ id: signedIn.json.customer.id, phone: '+966501234567', email: null, fullName: 'Aisha Rahman' })
    const out = await client.request('/api/customer/auth/logout', { method: 'POST', cookie })
    expectStandardError(await client.request('/api/customer/auth/me', { cookie: cookieOf(out.setCookie) }), { status: 401 })
  })

  it('a wrong code is 401 OTP_INVALID; customer sessions never reach staff or agency routes, nor the reverse', async () => {
    const { organization, scope } = await makeOrg(db)
    const { challengeId } = await plantChallenge(organization.id, '+966501234568')
    expectStandardError(await client.request('/api/customer/auth/otp/verify', { method: 'POST', body: { organizationSlug: organization.slug, challengeId, code: '000000', fullName: 'X' } }), { status: 401, code: 'OTP_INVALID' })

    const ok = await plantChallenge(organization.id, '+966501234569')
    const cookie = cookieOf((await client.request('/api/customer/auth/otp/verify', { method: 'POST', body: { organizationSlug: organization.slug, ...ok, fullName: 'Omar' } })).setCookie)
    expectStandardError(await client.request('/api/hotels', { cookie }), { status: 401 })
    expectStandardError(await client.request('/api/agency/auth/me', { cookie }), { status: 401 })

    const { user, password } = await makeLoginableUser(db, scope)
    const staff = await client.login(organization.slug, user.email, password)
    expectStandardError(await client.request('/api/customer/auth/me', { cookie: staff.cookie }), { status: 401 })
  })
})

describe('customer sign-in by e-mail over HTTP (D-P2-68)', () => {
  const request = (body: Record<string, unknown>, headers?: Record<string, string>) => client.request('/api/customer/auth/otp/request', { method: 'POST', body, headers })

  it('without an e-mail provider a code request is 503 EMAIL_UNAVAILABLE; a malformed address, or a phone and an address together, is 422', async () => {
    const { organization } = await makeOrg(db)
    expectStandardError(await request({ organizationSlug: organization.slug, email: ' Aisha@Example.com ' }), { status: 503, code: 'EMAIL_UNAVAILABLE' })

    const malformed = await request({ organizationSlug: organization.slug, email: 'aisha@' })
    expectStandardError(malformed, { status: 422, code: 'VALIDATION_FAILED' })
    expect(malformed.json.data.details.issues).toEqual([expect.objectContaining({ path: ['email'] })])
    expectStandardError(await request({ organizationSlug: organization.slug, phone: '+966501234567', email: 'aisha@example.com' }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await request({ organizationSlug: organization.slug }), { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('a correct e-mailed code signs a new customer up by their address; me names it, with no phone', async () => {
    const { organization } = await makeOrg(db)
    const planted = await plantChallenge(organization.id, 'aisha@example.com')
    const signedIn = await client.request('/api/customer/auth/otp/verify', { method: 'POST', body: { organizationSlug: organization.slug, ...planted, fullName: 'Aisha Rahman' } })
    expect(signedIn.status).toBe(200)
    expect(signedIn.json).toEqual({ customer: { id: expect.any(String), phone: null, email: 'aisha@example.com', fullName: 'Aisha Rahman' }, isNew: true })
    const me = await client.request('/api/customer/auth/me', { cookie: cookieOf(signedIn.setCookie) })
    expect(me.json).toEqual({ id: signedIn.json.customer.id, phone: null, email: 'aisha@example.com', fullName: 'Aisha Rahman' })
  })

  it('both code routes refuse a foreign Origin (403 CSRF_ORIGIN_MISMATCH) before they run, for an address as for a phone; the site\'s own origin passes', async () => {
    const { organization } = await makeOrg(db)
    const planted = await plantChallenge(organization.id, 'omar@example.com')
    for (const origin of ['https://evil.example', 'null']) {
      for (const destination of [{ email: 'omar@example.com' }, { phone: '+966501234567' }]) {
        expectStandardError(await request({ organizationSlug: organization.slug, ...destination }, { origin }), { status: 403, code: 'CSRF_ORIGIN_MISMATCH' })
      }
      const verify = await client.request('/api/customer/auth/otp/verify', { method: 'POST', headers: { origin }, body: { organizationSlug: organization.slug, ...planted, fullName: 'Omar' } })
      expectStandardError(verify, { status: 403, code: 'CSRF_ORIGIN_MISMATCH' })
      expect(verify.setCookie).toEqual([])
    }
    expectStandardError(await request({ organizationSlug: organization.slug, email: 'omar@example.com' }, { 'sec-fetch-site': 'cross-site' }), { status: 403, code: 'CSRF_ORIGIN_MISMATCH' })
    // The refused verifications never reached the code: it still signs in, from the site itself.
    const ownOrigin = { origin: `http://${new URL(baseUrl).host}`, 'sec-fetch-site': 'same-origin' }
    expectStandardError(await request({ organizationSlug: organization.slug, email: 'omar@example.com' }, ownOrigin), { status: 503, code: 'EMAIL_UNAVAILABLE' })
    const verified = await client.request('/api/customer/auth/otp/verify', { method: 'POST', headers: ownOrigin, body: { organizationSlug: organization.slug, ...planted, fullName: 'Omar' } })
    expect(verified.status).toBe(200)
  })

  it('a server that e-mails codes (EMAIL_DRIVER=log, development) sends one that signs in; the log masks the address', async () => {
    const { organization } = await makeOrg(db)
    const server = await startExtraServer({ EMAIL_DRIVER: 'log' })
    try {
      const api = apiClient(server.baseUrl)
      const issued = await api.request('/api/customer/auth/otp/request', { method: 'POST', body: { organizationSlug: organization.slug, email: 'Fatima@Example.com' } })
      expect(issued.status).toBe(202)
      expect(issued.json).toEqual({ challengeId: expect.any(String), expiresInSeconds: 300 })
      const logged = server.output()
      expect(logged).toContain('[email] to f…@example.com: Your sign-in code')
      expect(logged).not.toContain('fatima@')
      const code = /^(\d{6})$/m.exec(logged)![1]!
      const signedIn = await api.request('/api/customer/auth/otp/verify', { method: 'POST', body: { organizationSlug: organization.slug, challengeId: issued.json.challengeId, code, fullName: 'Fatima' } })
      expect(signedIn.json).toEqual({ customer: { id: expect.any(String), phone: null, email: 'fatima@example.com', fullName: 'Fatima' }, isNew: true })
    }
    finally {
      await server.stop()
    }
  }, 30_000)

  it('refuses to start e-mailing codes outside development without the bot check, never echoing the app password', async () => {
    const result = await expectServerToFailStartup({ APP_ENV: 'demo', EMAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'stays@gmail.com', SMTP_PASSWORD: 'app-password-secret', EMAIL_FROM: 'Hajj & Umrah Stays <stays@gmail.com>' })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/CAPTCHA_DRIVER must be turnstile when sign-in codes are e-mailed outside APP_ENV=development/)
    expect(result.output).not.toContain('app-password-secret')
  }, 30_000)
})
