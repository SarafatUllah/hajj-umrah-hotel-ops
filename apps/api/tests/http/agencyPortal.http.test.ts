import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeLoginableUser, makeOrg, makeRole, truncateAllTables } from './support/fixtures'
import { tenantRepos } from '../../server/repositories'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()
const PASSWORD = 'Agency-Passw0rd!'

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const cookieOf = (setCookie: string[]) => setCookie.map(entry => entry.split(';')[0]).join('; ')

async function setup() {
  const { organization, scope } = await makeOrg(db)
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: true })
  const role = await makeRole(db, scope, { permissions: ['agency.view', 'agency.manage', 'hotel.view'] })
  await tenantRepos(db, scope).roles.assignToUser(user.id, role.id)
  const staff = await client.login(organization.slug, user.email, password)
  return { slug: organization.slug, staffCookie: staff.cookie }
}

const registration = (slug: string) => ({
  organizationSlug: slug,
  agency: { name: 'Al-Noor Travels', licenseNo: 'LIC-77', contactName: 'Karim', phone: '+966 50 000 0001', email: 'office@alnoor.test' },
  user: { fullName: 'Karim', email: 'karim@alnoor.test', password: PASSWORD },
})

const agencyLogin = (slug: string) => client.request('/api/agency/auth/login', { method: 'POST', body: { organizationSlug: slug, email: 'karim@alnoor.test', password: PASSWORD } })

describe('agency portal', () => {
  it('register (PENDING) → sign in → me shows PENDING → staff approve → me shows APPROVED', async () => {
    const env = await setup()
    const registered = await client.request('/api/agency/register', { method: 'POST', body: registration(env.slug) })
    expect(registered.status).toBe(202)
    expect(registered.json).toEqual({ received: true })
    const agencyId = (await client.request('/api/agencies?status=PENDING', { cookie: env.staffCookie })).json.items[0].id as string

    const signedIn = await agencyLogin(env.slug)
    expect(signedIn.status).toBe(200)
    const cookie = cookieOf(signedIn.setCookie)
    expect((await client.request('/api/agency/auth/me', { cookie })).json.agency).toEqual({ id: agencyId, name: 'Al-Noor Travels', status: 'PENDING' })

    const approved = await client.request(`/api/agencies/${agencyId}/status`, { method: 'POST', cookie: env.staffCookie, body: { status: 'APPROVED', reason: 'Licence checked' } })
    expect(approved.json).toMatchObject({ status: 'APPROVED', phone: '+966500000001' })
    expect((await client.request('/api/agency/auth/me', { cookie })).json.agency).toMatchObject({ status: 'APPROVED' })
  })

  it('agency and staff sessions never cross: each is 401 on the other\'s routes', async () => {
    const env = await setup()
    await client.request('/api/agency/register', { method: 'POST', body: registration(env.slug) })
    const cookie = cookieOf((await agencyLogin(env.slug)).setCookie)

    expectStandardError(await client.request('/api/hotels', { cookie }), { status: 401 })
    expectStandardError(await client.request('/api/agencies', { cookie }), { status: 401 })
    expectStandardError(await client.request('/api/auth/me', { cookie }), { status: 401 })
    expectStandardError(await client.request('/api/agency/auth/me', { cookie: env.staffCookie }), { status: 401 })
    expect((await client.request('/api/agency/auth/me', { cookie })).status).toBe(200)
  })

  it('a wrong password is 401 INVALID_CREDENTIALS; a deactivated user\'s session ends at once', async () => {
    const env = await setup()
    await client.request('/api/agency/register', { method: 'POST', body: registration(env.slug) })
    const agencyId = (await client.request('/api/agencies', { cookie: env.staffCookie })).json.items[0].id as string
    expectStandardError(await client.request('/api/agency/auth/login', { method: 'POST', body: { organizationSlug: env.slug, email: 'karim@alnoor.test', password: 'wrong-password' } }), { status: 401, code: 'INVALID_CREDENTIALS' })

    const cookie = cookieOf((await agencyLogin(env.slug)).setCookie)
    const detail = await client.request(`/api/agencies/${agencyId}`, { cookie: env.staffCookie })
    const userId = detail.json.users[0].id as string
    await client.request(`/api/agencies/${agencyId}/users/${userId}`, { method: 'PATCH', cookie: env.staffCookie, body: { isActive: false } })

    expectStandardError(await client.request('/api/agency/auth/me', { cookie }), { status: 401 })
  })

  it('registration validates input without echoing the password, and answers a duplicate exactly like a new one', async () => {
    const env = await setup()
    const bad = await client.request('/api/agency/register', { method: 'POST', body: { ...registration(env.slug), user: { fullName: 'K', email: 'not-an-email', password: 'short' } } })
    expectStandardError(bad, { status: 422, code: 'VALIDATION_FAILED' })
    expect(JSON.stringify(bad.json)).not.toContain('short')

    const first = await client.request('/api/agency/register', { method: 'POST', body: registration(env.slug) })
    const duplicate = await client.request('/api/agency/register', { method: 'POST', body: { ...registration(env.slug), user: { ...registration(env.slug).user, email: 'other@alnoor.test' } } })
    expect([duplicate.status, duplicate.json]).toEqual([first.status, first.json])
  })

  it('a pending agency may still use its own me', async () => {
    const env = await setup()
    await client.request('/api/agency/register', { method: 'POST', body: registration(env.slug) })
    const cookie = cookieOf((await agencyLogin(env.slug)).setCookie)
    expect((await client.request('/api/agency/auth/me', { cookie })).status).toBe(200)
  })
})
