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
  const role = await makeRole(db, scope, { permissions: ['booking.view', 'booking.create', 'booking.checkIn', 'occupancy.view'] })
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

  it('the agency enters a pilgrim\'s details (PUT), sees them in full; a woman in a men\'s slot is 422', async () => {
    const env = await setup()
    const search = await client.request('/api/agency/stays/search', { method: 'POST', cookie: env.agencyCookie, body: stay(env.hotel.id) })
    const held = await client.request('/api/agency/bookings', { method: 'POST', cookie: env.agencyCookie, body: { ...stay(env.hotel.id), rooms: chosen(search.json.options[0]) } })
    const slots = await client.request(`/api/agency/bookings/${held.json.id}/guests`, { cookie: env.agencyCookie })
    const man = slots.json.find((s: { gender: string }) => s.gender === 'MALE')
    const details = { fullName: 'Md. Karim', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNo: 'A1234567', passportExpiry: '2030-01-01' }
    const saved = await client.request(`/api/agency/bookings/${held.json.id}/guests/${man.id}`, { method: 'PUT', cookie: env.agencyCookie, body: details })
    expect(saved.json).toMatchObject({ status: 'READY', details: { passportNo: '•••567' } })
    const mine = await client.request(`/api/agency/bookings/${held.json.id}/guests`, { cookie: env.agencyCookie })
    expect(mine.json.find((s: { id: string }) => s.id === man.id).details.passportNo).toBe('A1234567')
    expectStandardError(await client.request(`/api/agency/bookings/${held.json.id}/guests/${man.id}`, { method: 'PUT', cookie: env.agencyCookie, body: { ...details, gender: 'FEMALE' } }), { status: 422, code: 'GUEST_DETAILS_REJECTED' })
    // Staff without pilgrim.view cannot see the slots at all.
    const staffView = await client.request(`/api/bookings/${held.json.id}/guests`, { cookie: env.staffCookie })
    expect(staffView.status).toBe(403)
  })

  it('the desk posts the receipt\'s QR token to find the booking; moves before the stay are 409; the task list answers', async () => {
    const env = await setup()
    const search = await client.request('/api/agency/stays/search', { method: 'POST', cookie: env.agencyCookie, body: stay(env.hotel.id) })
    const held = await client.request('/api/agency/bookings', { method: 'POST', cookie: env.agencyCookie, body: { ...stay(env.hotel.id), rooms: chosen(search.json.options[0]) } })
    const confirmed = await client.request(`/api/agency/bookings/${held.json.id}/confirm`, { method: 'POST', cookie: env.agencyCookie })

    const found = await client.request('/api/check-in/lookup', { method: 'POST', cookie: env.staffCookie, body: { receiptToken: confirmed.json.receiptToken } })
    expect(found.json).toMatchObject({ bookingId: held.json.id, status: 'CONFIRMED' })
    expectStandardError(await client.request('/api/check-in/lookup', { method: 'POST', cookie: env.staffCookie, body: { receiptToken: 'not a code' } }), { status: 422 })
    expectStandardError(await client.request('/api/check-in/lookup', { method: 'POST', cookie: env.agencyCookie, body: { receiptToken: confirmed.json.receiptToken } }), { status: 401 })

    const [slot] = (await client.request(`/api/agency/bookings/${held.json.id}/guests`, { cookie: env.agencyCookie })).json
    expectStandardError(await client.request(`/api/bookings/${held.json.id}/guests/${slot.id}/no-show`, { method: 'POST', cookie: env.staffCookie }), { status: 409, code: 'BEFORE_CHECK_IN' })
    expectStandardError(await client.request(`/api/bookings/${held.json.id}/guests/${slot.id}/check-in`, { method: 'POST', cookie: env.staffCookie }), { status: 422, code: 'DETAILS_INCOMPLETE' })

    const tasks = await client.request(`/api/hotels/${env.hotel.id}/tasks?status=OPEN`, { cookie: env.staffCookie })
    expect(tasks).toMatchObject({ status: 200, json: [] })
  })

  it('the occupancy calendar: a range of days and one day\'s floor map; a reversed range is 422, agencies get 401', async () => {
    const env = await setup()
    const search = await client.request('/api/agency/stays/search', { method: 'POST', cookie: env.agencyCookie, body: stay(env.hotel.id) })
    await client.request('/api/agency/bookings', { method: 'POST', cookie: env.agencyCookie, body: { ...stay(env.hotel.id), rooms: chosen(search.json.options[0]) } })

    const range = await client.request(`/api/hotels/${env.hotel.id}/occupancy?from=2027-06-01&to=2027-06-03`, { cookie: env.staffCookie })
    expect(range.status).toBe(200)
    expect(range.json.days.map((d: { date: string }) => d.date)).toEqual(['2027-06-01', '2027-06-02', '2027-06-03'])
    expect(range.json.days[0]).toMatchObject({ rooms: { total: 6, held: 2 }, seats: { held: 6 } })
    const day = await client.request(`/api/hotels/${env.hotel.id}/occupancy/2027-06-02`, { cookie: env.staffCookie })
    expect(day.json.floors.map((f: { level: number }) => f.level)).toEqual([1, 2])
    expectStandardError(await client.request(`/api/hotels/${env.hotel.id}/occupancy?from=2027-06-03&to=2027-06-01`, { cookie: env.staffCookie }), { status: 422 })
    expectStandardError(await client.request(`/api/hotels/${env.hotel.id}/occupancy/2027-06-02`, { cookie: env.agencyCookie }), { status: 401 })
  })
})
