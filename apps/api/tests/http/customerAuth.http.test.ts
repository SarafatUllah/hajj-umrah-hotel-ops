import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { otpChallenge } from '@hajj/db/schema'
import { hashOtpCode } from '../../server/security/otp'
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

const cookieOf = (setCookie: string[]) => setCookie.map(entry => entry.split(';')[0]).join('; ')

/** The harness server sends no SMS (SMS_DRIVER defaults to disabled), so a challenge with a known code is planted directly. */
async function plantChallenge(organizationId: string, phone: string, code = '482913') {
  const id = randomUUID()
  await db.insert(otpChallenge).values({ id, organizationId, phone, codeHash: hashOtpCode(id, code), expiresAt: new Date(Date.now() + 300_000) })
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
    expect(signedIn.json).toEqual({ customer: { id: expect.any(String), phone: '+966501234567', fullName: 'Aisha Rahman' }, isNew: true })

    const cookie = cookieOf(signedIn.setCookie)
    expect((await client.request('/api/customer/auth/me', { cookie })).json).toEqual({ id: signedIn.json.customer.id, phone: '+966501234567', fullName: 'Aisha Rahman' })
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
