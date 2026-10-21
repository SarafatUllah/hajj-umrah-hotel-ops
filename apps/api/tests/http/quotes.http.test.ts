import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { tenantRepos } from '../../server/repositories'
import { hashPassword } from '../../server/utils/password'
import { AgencyUserRepository } from '../../server/repositories/accounts'
import { makeAgency } from '../support/bookingFixtures'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeHotel, makeLoginableUser, makeOrg, makeRole, truncateAllTables } from './support/fixtures'

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

async function setup(agencyStatus: 'APPROVED' | 'PENDING' = 'APPROVED') {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope)
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: true })
  const role = await makeRole(db, scope, { permissions: ['quote.manage', 'booking.view'] })
  await tenantRepos(db, scope).roles.assignToUser(user.id, role.id)
  const staff = await client.login(organization.slug, user.email, password)
  const agency = await makeAgency(db, scope, agencyStatus === 'PENDING' ? { status: 'PENDING', approvedAt: null } : {})
  await new AgencyUserRepository(db, scope).insert({ agencyId: agency.id, email: 'agent@alnoor.test', passwordHash: await hashPassword(PASSWORD), fullName: 'Agent' })
  const agent = await client.request('/api/agency/auth/login', { method: 'POST', body: { organizationSlug: organization.slug, email: 'agent@alnoor.test', password: PASSWORD } })
  return { hotel, staffCookie: staff.cookie, agencyCookie: cookieOf(agent.setCookie) }
}

const body = (hotelId: string) => ({ hotelId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-10', maleCount: 18, femaleCount: 12, totalCount: 30 })

describe('WhatsApp quotes over HTTP', () => {
  it('the agency asks, staff offer the price, the agency sees it', async () => {
    const env = await setup()
    const asked = await client.request('/api/agency/quotes', { method: 'POST', cookie: env.agencyCookie, body: body(env.hotel.id) })
    expect(asked.status).toBe(201)
    expect(asked.json.quote).toMatchObject({ status: 'REQUESTED', refNo: expect.stringMatching(/^Q-\d{4}-0001$/) })

    const offered = await client.request(`/api/quotes/${asked.json.quote.id}/offer`, { method: 'POST', cookie: env.staffCookie, body: { amountHalalas: 35000, unit: 'PER_PERSON_NIGHT', vatIncluded: true } })
    expect(offered.json).toMatchObject({ quote: { status: 'OFFERED', amountHalalas: 35000 }, aboveHighestPublicRate: false })

    const mine = await client.request('/api/agency/quotes', { cookie: env.agencyCookie })
    expect(mine.json).toMatchObject({ total: 1, items: [{ status: 'OFFERED', amountHalalas: 35000 }] })
  })

  it('a bad request is 422 (men + women ≠ total); a pending agency is 403 AGENCY_NOT_APPROVED', async () => {
    const env = await setup()
    expectStandardError(await client.request('/api/agency/quotes', { method: 'POST', cookie: env.agencyCookie, body: { ...body(env.hotel.id), totalCount: 29 } }), { status: 422, code: 'VALIDATION_FAILED' })

    const pending = await setup('PENDING')
    expectStandardError(await client.request('/api/agency/quotes', { method: 'POST', cookie: pending.agencyCookie, body: body(pending.hotel.id) }), { status: 403, code: 'AGENCY_NOT_APPROVED' })
  })
})
