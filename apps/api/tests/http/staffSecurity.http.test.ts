import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { RATE_LIMITS } from '../../server/security/rateLimit'
import { totpCodeAt, totpStepAt } from '../../server/security/totp'
import { tenantRepos } from '../../server/repositories'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeLoginableUser, makeOrg, makeRole, makeUserWithPermissions, truncateAllTables } from './support/fixtures'
import { startExtraServer, type ExtraServer } from './support/spawnServer'

const baseUrl = inject('httpTestBaseUrl')
const client = apiClient(baseUrl)
const db = getHttpTestDb()

let enforcingServer: ExtraServer
let enforcing: ReturnType<typeof apiClient>

beforeAll(async () => {
  enforcingServer = await startExtraServer({ STAFF_2FA_ENFORCEMENT: 'required-roles' })
  enforcing = apiClient(enforcingServer.baseUrl)
}, 120_000)

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await enforcingServer?.stop()
  await closeTestDb()
})

async function makeStaff(options: { requiresTwoFactor?: boolean } = {}) {
  const { organization, scope } = await makeOrg(db)
  const { user, password } = await makeLoginableUser(db, scope)
  const role = await makeRole(db, scope, { permissions: ['hotel.view'] })
  const repos = tenantRepos(db, scope)
  await repos.roles.assignToUser(user.id, role.id)
  if (options.requiresTwoFactor) await repos.roles.setRequiresTwoFactor(role.id, true)
  return { slug: organization.slug, email: user.email, password }
}

const currentStep = () => totpStepAt(new Date())
/** The session cookie a response (re)issued, as a `Cookie` header value. */
const cookieOf = (setCookie: string[]) => setCookie.map(entry => entry.split(';')[0]).join('; ')

describe('POST /api/auth/login — rate limiting', () => {
  it('answers 429 TOO_MANY_REQUESTS with Retry-After after 5 attempts for one identity from one client', async () => {
    const staff = await makeStaff()
    for (let i = 0; i < RATE_LIMITS.loginPerClientIdentity.limit; i++) {
      expectStandardError(await client.login(staff.slug, staff.email, 'wrong-password'), { status: 401, code: 'INVALID_CREDENTIALS' })
    }

    const res = await client.request('/api/auth/login', { method: 'POST', body: { organizationSlug: staff.slug, email: staff.email, password: staff.password } })

    expectStandardError(res, { status: 429, code: 'TOO_MANY_REQUESTS' })
    const retryAfter = Number(res.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(RATE_LIMITS.loginPerClientIdentity.windowSeconds)
    expect(res.json.data.details.retryAfterSeconds).toBe(retryAfter)
    expect(res.setCookie).toEqual([])
  })
})

describe('CSRF origin check on unsafe /api/ requests', () => {
  const host = new URL(baseUrl).host

  it('refuses a foreign Origin (403 CSRF_ORIGIN_MISMATCH) before the route runs, and a null Origin', async () => {
    const staff = await makeStaff()
    for (const origin of ['https://evil.example', 'null']) {
      const res = await client.request('/api/auth/login', { method: 'POST', headers: { origin }, body: { organizationSlug: staff.slug, email: staff.email, password: staff.password } })
      expectStandardError(res, { status: 403, code: 'CSRF_ORIGIN_MISMATCH' })
      expect(res.setCookie).toEqual([])
    }
  })

  it('refuses Sec-Fetch-Site: cross-site without an Origin', async () => {
    const res = await client.request('/api/auth/logout', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
    expectStandardError(res, { status: 403, code: 'CSRF_ORIGIN_MISMATCH' })
  })

  it('accepts the request host as Origin, requests without Origin, and safe methods from anywhere', async () => {
    const staff = await makeStaff()
    const sameOrigin = await client.request('/api/auth/login', { method: 'POST', headers: { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, body: { organizationSlug: staff.slug, email: staff.email, password: staff.password } })
    expect(sameOrigin.status).toBe(200)

    expect((await client.login(staff.slug, staff.email, staff.password)).status).toBe(200)
    expect((await client.request('/api/health', { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status).toBe(200)
  })
})

describe('staff two-factor authentication over HTTP', () => {
  /** Logs in, starts setup and confirms it with the code of the current step; returns the (re-issued) cookie, the secret and that step. */
  async function enrolOverHttp(staff: { slug: string, email: string, password: string }, api = client) {
    const { cookie: firstCookie } = await api.login(staff.slug, staff.email, staff.password)
    const setup = await api.request('/api/auth/2fa/setup', { method: 'POST', cookie: firstCookie })
    const secret = setup.json.secret as string
    const step = currentStep()
    const enabled = await api.request('/api/auth/2fa/enable', { method: 'POST', cookie: firstCookie, body: { code: totpCodeAt(secret, step) } })
    expect(enabled.json).toEqual({ enabled: true })
    return { cookie: cookieOf(enabled.setCookie), firstCookie, secret, step }
  }

  it('setup returns the secret once (no-store) and a malformed code is 422', async () => {
    const staff = await makeStaff()
    const { cookie } = await client.login(staff.slug, staff.email, staff.password)
    expect((await client.request('/api/auth/2fa', { cookie })).json).toEqual({ enabled: false, setupPending: false, requiredByRole: false })

    const setup = await client.request('/api/auth/2fa/setup', { method: 'POST', cookie })
    expect(setup.status).toBe(200)
    expect(setup.headers.get('cache-control')).toBe('no-store')
    expect(setup.json.secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(setup.json.otpauthUri).toMatch(/^otpauth:\/\/totp\//)
    expect((await client.request('/api/auth/2fa', { cookie })).json).toMatchObject({ enabled: false, setupPending: true })

    const badEnable = await client.request('/api/auth/2fa/enable', { method: 'POST', cookie, body: { code: 'abc' } })
    expectStandardError(badEnable, { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('once enabled, login needs the code: missing → 401 TWO_FACTOR_REQUIRED, wrong → 401 TWO_FACTOR_INVALID, valid → 200', async () => {
    const staff = await makeStaff()
    const { secret, step } = await enrolOverHttp(staff)

    const noCode = await client.login(staff.slug, staff.email, staff.password)
    expectStandardError(noCode, { status: 401, code: 'TWO_FACTOR_REQUIRED' })
    expect(noCode.cookie).toBe('')
    const login = (totpCode: string) => client.request('/api/auth/login', { method: 'POST', body: { organizationSlug: staff.slug, email: staff.email, password: staff.password, totpCode } })
    expectStandardError(await login(totpCodeAt(secret, step + 9)), { status: 401, code: 'TWO_FACTOR_INVALID' })

    const ok = await login(totpCodeAt(secret, step + 1))
    expect(ok.status).toBe(200)
    const freshCookie = cookieOf(ok.setCookie)
    const me = await client.request('/api/auth/me', { cookie: freshCookie })
    expect(me.json.twoFactorEnrollmentRequired).toBe(false)
    expect((await client.request('/api/auth/2fa', { cookie: freshCookie })).json).toMatchObject({ enabled: true })
  })

  it('enable keeps the enrolling session signed in (re-issued cookie) and ends every other session of the user', async () => {
    const staff = await makeStaff()
    const other = await client.login(staff.slug, staff.email, staff.password)
    const { cookie, firstCookie } = await enrolOverHttp(staff)

    expect((await client.request('/api/auth/me', { cookie })).status).toBe(200)
    expectStandardError(await client.request('/api/auth/me', { cookie: other.cookie }), { status: 401 })
    expectStandardError(await client.request('/api/auth/me', { cookie: firstCookie }), { status: 401 })
  })

  it('disable needs a current code; afterwards the password alone logs in again', async () => {
    const staff = await makeStaff()
    const { cookie, secret, step } = await enrolOverHttp(staff)

    expectStandardError(await client.request('/api/auth/2fa/disable', { method: 'POST', cookie, body: { code: totpCodeAt(secret, step) } }), { status: 422, code: 'TWO_FACTOR_CODE_INVALID' })
    const disabled = await client.request('/api/auth/2fa/disable', { method: 'POST', cookie, body: { code: totpCodeAt(secret, step + 1) } })
    expect(disabled.json).toEqual({ enabled: false })
    expect((await client.request('/api/auth/me', { cookie: cookieOf(disabled.setCookie) })).status).toBe(200)
    expect((await client.login(staff.slug, staff.email, staff.password)).status).toBe(200)
  })

  it('an administrator with user.manage resets another user\'s 2FA (lost device): the user is signed out and logs in with the password', async () => {
    const { organization, scope } = await makeOrg(db)
    const { user, password } = await makeLoginableUser(db, scope)
    const staff = { slug: organization.slug, email: user.email, password }
    const { cookie: targetCookie } = await enrolOverHttp(staff)
    const admin = await makeUserWithPermissions(db, scope, ['user.manage'], { allHotels: true, passwordHash: (await makeLoginableUser(db, scope)).user.passwordHash })
    const { cookie: adminCookie } = await client.login(organization.slug, admin.user.email, password)

    expectStandardError(await client.request(`/api/users/${user.id}/2fa/reset`, { method: 'POST', cookie: adminCookie, body: {} }), { status: 422, code: 'VALIDATION_FAILED' })
    const reset = await client.request(`/api/users/${user.id}/2fa/reset`, { method: 'POST', cookie: adminCookie, body: { reason: 'Phone lost' } })
    expect(reset.json).toEqual({ reset: true })

    expectStandardError(await client.request('/api/auth/me', { cookie: targetCookie }), { status: 401 })
    expect((await client.login(staff.slug, staff.email, staff.password)).status).toBe(200)
    expectStandardError(await client.request(`/api/users/${admin.user.id}/2fa/reset`, { method: 'POST', cookie: targetCookie, body: { reason: 'x'.repeat(5) } }), { status: 401 })
  })

  it('the 2FA routes require a session', async () => {
    expectStandardError(await client.request('/api/auth/2fa/setup', { method: 'POST' }), { status: 401 })
    expectStandardError(await client.request('/api/auth/2fa'), { status: 401 })
  })
})

describe('STAFF_2FA_ENFORCEMENT=required-roles', () => {
  it('a user whose role requires 2FA reaches only auth/me and the 2FA routes until enrolled', async () => {
    const staff = await makeStaff({ requiresTwoFactor: true })
    const { cookie, status } = await enforcing.login(staff.slug, staff.email, staff.password)
    expect(status).toBe(200)

    expectStandardError(await enforcing.request('/api/hotels', { cookie }), { status: 403, code: 'TWO_FACTOR_ENROLLMENT_REQUIRED' })
    const me = await enforcing.request('/api/auth/me', { cookie })
    expect(me.status).toBe(200)
    expect(me.json.twoFactorEnrollmentRequired).toBe(true)
    expect((await enforcing.request('/api/auth/2fa', { cookie })).json.requiredByRole).toBe(true)

    const setup = await enforcing.request('/api/auth/2fa/setup', { method: 'POST', cookie })
    const enabled = await enforcing.request('/api/auth/2fa/enable', { method: 'POST', cookie, body: { code: totpCodeAt(setup.json.secret, currentStep()) } })
    const enrolledCookie = cookieOf(enabled.setCookie)

    expect((await enforcing.request('/api/hotels', { cookie: enrolledCookie })).status).toBe(200)
    expect((await enforcing.request('/api/auth/me', { cookie: enrolledCookie })).json.twoFactorEnrollmentRequired).toBe(false)
  })

  it('a user whose roles do not require 2FA is not gated', async () => {
    const staff = await makeStaff()
    const { cookie } = await enforcing.login(staff.slug, staff.email, staff.password)
    expect((await enforcing.request('/api/hotels', { cookie })).status).toBe(200)
  })
})
