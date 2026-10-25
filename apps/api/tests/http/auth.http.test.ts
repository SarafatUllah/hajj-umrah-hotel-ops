import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeLoginableUser, makeOrg, truncateAllTables } from './support/fixtures'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('POST /api/auth/login — cookie hardening (proof 1)', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie with ~8h lifetime and no Secure flag in the test env', async () => {
    const { organization, scope } = await makeOrg(db)
    const { user, password } = await makeLoginableUser(db, scope)

    const res = await client.request('/api/auth/login', {
      method: 'POST',
      body: { organizationSlug: organization.slug, email: user.email, password },
    })

    expect(res.status).toBe(200)
    const sessionCookie = res.setCookie.find(entry => /HttpOnly/i.test(entry))
    expect(sessionCookie, `expected a Set-Cookie header, got: ${JSON.stringify(res.setCookie)}`).toBeDefined()

    expect(sessionCookie).toMatch(/HttpOnly/i)
    expect(sessionCookie).toMatch(/SameSite=Lax/i)
    // Production requires Secure (see nuxt.config.ts's session cookie default and Task 21's deploy
    // checklist, NUXT_SESSION_COOKIE_SECURE=true) — the test environment explicitly sets it false
    // (Node test clients cannot send a Secure cookie over http), and this asserts that absence.
    expect(sessionCookie).not.toMatch(/;\s*Secure(;|$)/i)

    const maxAgeMatch = /Max-Age=(\d+)/i.exec(sessionCookie!)
    const expiresMatch = /Expires=([^;]+)/i.exec(sessionCookie!)
    expect(maxAgeMatch ?? expiresMatch, `expected Max-Age or Expires on: ${sessionCookie}`).toBeTruthy()

    const EXPECTED_SECONDS = 60 * 60 * 8
    const TOLERANCE_SECONDS = 60
    if (maxAgeMatch) {
      expect(Number(maxAgeMatch[1])).toBeGreaterThanOrEqual(EXPECTED_SECONDS - TOLERANCE_SECONDS)
      expect(Number(maxAgeMatch[1])).toBeLessThanOrEqual(EXPECTED_SECONDS + TOLERANCE_SECONDS)
    }
    else {
      const expiresAt = new Date(expiresMatch![1]!).getTime()
      const deltaSeconds = (expiresAt - Date.now()) / 1000
      expect(deltaSeconds).toBeGreaterThanOrEqual(EXPECTED_SECONDS - TOLERANCE_SECONDS)
      expect(deltaSeconds).toBeLessThanOrEqual(EXPECTED_SECONDS + TOLERANCE_SECONDS)
    }
  })
})

describe('POST /api/auth/login — identity-only response (proof 2)', () => {
  it('never serializes permissions, allHotels, or hotelIds', async () => {
    const { organization, scope } = await makeOrg(db)
    const { user, password } = await makeLoginableUser(db, scope)

    const res = await client.login(organization.slug, user.email, password)

    expect(res.status).toBe(200)
    expect(res.json.user).toBeTruthy()
    expect(res.json.user.id).toBe(user.id)

    const serialized = JSON.stringify(res.json)
    expect(serialized).not.toMatch(/"permissions"/)
    expect(serialized).not.toMatch(/"allHotels"/)
    expect(serialized).not.toMatch(/"hotelIds"/)
  })
})

describe('POST /api/auth/login — indistinguishability (proof 6)', () => {
  it('unknown organization, unknown email, and wrong password all produce an identical error', async () => {
    const { organization, scope } = await makeOrg(db)
    const { user, password: correctPassword } = await makeLoginableUser(db, scope)

    const unknownOrg = await client.login('no-such-org-slug', user.email, correctPassword)
    const unknownEmail = await client.login(organization.slug, 'nobody@example.test', correctPassword)
    const wrongPassword = await client.login(organization.slug, user.email, 'definitely-wrong-password')

    for (const res of [unknownOrg, unknownEmail, wrongPassword]) {
      expectStandardError(res)
    }

    expect(unknownOrg.status).toBe(unknownEmail.status)
    expect(unknownEmail.status).toBe(wrongPassword.status)
    expect(unknownOrg.json.statusMessage).toBe(unknownEmail.json.statusMessage)
    expect(unknownEmail.json.statusMessage).toBe(wrongPassword.json.statusMessage)
    expect(unknownOrg.json.data.code).toBe(unknownEmail.json.data.code)
    expect(unknownEmail.json.data.code).toBe(wrongPassword.json.data.code)
  })
})

describe('POST /api/auth/login — malformed body (proof 7)', () => {
  it('returns 422 VALIDATION_FAILED with issues[].path, and never echoes the submitted password', async () => {
    const secretPassword = 'super-secret-should-never-appear-Xk92'

    const res = await client.request('/api/auth/login', {
      method: 'POST',
      body: { organizationSlug: 123, email: 'not-an-email', password: secretPassword },
    })

    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
    expect(Array.isArray(res.json.data.details?.issues)).toBe(true)
    expect(res.json.data.details.issues.length).toBeGreaterThan(0)
    for (const issue of res.json.data.details.issues) {
      expect(Array.isArray(issue.path)).toBe(true)
    }

    const serialized = JSON.stringify(res.json)
    expect(serialized).not.toContain(secretPassword)
  })

  it('rejects a missing password without echoing anything about it', async () => {
    const res = await client.request('/api/auth/login', {
      method: 'POST',
      body: { organizationSlug: 'some-org', email: 'user@example.test' },
    })

    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })
})
