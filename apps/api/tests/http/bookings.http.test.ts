import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { tenantRepos } from '../../server/repositories'
import { AgencyUserRepository } from '../../server/repositories/accounts'
import { hashPassword } from '../../server/utils/password'
import { makeAgency } from '../support/bookingFixtures'
import { makeStayHotel } from '../support/stayFixtures'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeLoginableUser, makeOrg, makeRole, truncateAllTables } from './support/fixtures'

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
  const { hotel, rooms } = await makeStayHotel(db, scope)
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: true })
  const role = await makeRole(db, scope, { permissions: ['booking.view', 'booking.create'] })
  await tenantRepos(db, scope).roles.assignToUser(user.id, role.id)
  const staff = await client.login(organization.slug, user.email, password)
  const agency = await makeAgency(db, scope)
  await new AgencyUserRepository(db, scope).insert({ agencyId: agency.id, email: 'agent@alnoor.test', passwordHash: await hashPassword(PASSWORD), fullName: 'Agent' })
  const agent = await client.request('/api/agency/auth/login', { method: 'POST', body: { organizationSlug: organization.slug, email: 'agent@alnoor.test', password: PASSWORD } })
  return { hotel, rooms, agencyId: agency.id, staffCookie: staff.cookie, agencyCookie: cookieOf(agent.setCookie) }
}

const stay = (hotelId: string) => ({ hotelId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-04', maleCount: 4, femaleCount: 2, totalCount: 6 })
const chosen = (option: { rooms: Array<{ roomId: string, occupancy: string, seats: number, extraBeds: number }> }) => option.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds }))

describe('bookings over HTTP (v7 §7, §9–10)', () => {
  it('an agency searches, holds (201), confirms and gets the receipt with its QR token', async () => {
    const env = await setup()
    const search = await client.request('/api/agency/stays/search', { method: 'POST', cookie: env.agencyCookie, body: stay(env.hotel.id) })
    expect(search.status).toBe(200)
    expect(search.json.options[0]).toMatchObject({ newRooms: 2, emptySeats: 0, priceSource: 'AGENCY_DEFAULT' })

    const held = await client.request('/api/agency/bookings', { method: 'POST', cookie: env.agencyCookie, body: { ...stay(env.hotel.id), rooms: chosen(search.json.options[0]) } })
    expect(held.status).toBe(201)
    expect(held.json).toMatchObject({ status: 'HELD', bookingNo: expect.stringMatching(/^B-\d{4}-0001$/) })

    const confirmed = await client.request(`/api/agency/bookings/${held.json.id}/confirm`, { method: 'POST', cookie: env.agencyCookie })
    expect(confirmed.json).toMatchObject({ status: 'CONFIRMED', guests: { total: 6, withDetails: 0 } })
    const receipt = await client.request(`/api/agency/bookings/${held.json.id}/receipt`, { cookie: env.agencyCookie })
    expect(receipt.json).toMatchObject({ bookingNo: held.json.bookingNo, nights: 3, qrToken: confirmed.json.receiptToken })

    const list = await client.request('/api/agency/bookings?status=CONFIRMED', { cookie: env.agencyCookie })
    expect(list.json).toMatchObject({ total: 1, items: [{ id: held.json.id }] })
    // Staff see it too.
    expect((await client.request(`/api/bookings/${held.json.id}`, { cookie: env.staffCookie })).json).toMatchObject({ status: 'CONFIRMED' })
  })

  it('staff book on an agency\'s behalf; a room taken meanwhile is 409, a bad head count 422', async () => {
    const env = await setup()
    const body = { ...stay(env.hotel.id), agencyId: env.agencyId }
    const search = await client.request('/api/stays/search', { method: 'POST', cookie: env.staffCookie, body })
    const rooms = chosen(search.json.options[0])
    const held = await client.request('/api/bookings', { method: 'POST', cookie: env.staffCookie, body: { ...body, rooms } })
    expect(held.status).toBe(201)

    // The agency's own rooms now hold every seat it asked for: a second hold of the same rooms has nothing left.
    expectStandardError(await client.request('/api/agency/bookings', { method: 'POST', cookie: env.agencyCookie, body: { ...stay(env.hotel.id), rooms } }), { status: 409, code: 'OPTION_UNAVAILABLE' })
    expectStandardError(await client.request('/api/agency/stays/search', { method: 'POST', cookie: env.agencyCookie, body: { ...stay(env.hotel.id), totalCount: 7 } }), { status: 422, code: 'VALIDATION_FAILED' })

    const confirmed = await client.request(`/api/bookings/${held.json.id}/confirm`, { method: 'POST', cookie: env.staffCookie })
    expect(confirmed.json.status).toBe('CONFIRMED')
    expect((await client.request(`/api/bookings/${held.json.id}/receipt`, { cookie: env.staffCookie })).json.qrToken).toBe(confirmed.json.receiptToken)
  })
})
