import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { tenantRepos } from '../../server/repositories'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, getHttpTestDb, makeHotel, makeLoginableUser, makeOrg, makeRole, makeRoomType, truncateAllTables } from './support/fixtures'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function setup() {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope)
  const roomType = await makeRoomType(db, scope)
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: true })
  const role = await makeRole(db, scope, { permissions: ['rate.view', 'rate.manage', 'booking.view', 'booking.settings'] })
  await tenantRepos(db, scope).roles.assignToUser(user.id, role.id)
  const { cookie } = await client.login(organization.slug, user.email, password)
  return { hotel, roomType, cookie }
}

describe('booking rules and settings over HTTP', () => {
  it('creates and lists a rate; a bad body is 422 with issue paths; an unknown kind is 422; an overlap is 409', async () => {
    const env = await setup()
    const url = `/api/hotels/${env.hotel.id}/booking-rules/rates`
    const body = { roomTypeId: env.roomType.id, priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', startDate: '2027-06-01', endDate: '2027-06-30', amountHalalas: 38000, vatIncluded: true }

    const created = await client.request(url, { method: 'POST', cookie: env.cookie, body })
    expect(created.status).toBe(201)
    expect((await client.request(url, { cookie: env.cookie })).json).toEqual([created.json])

    const bad = await client.request(url, { method: 'POST', cookie: env.cookie, body: { ...body, amountHalalas: -5 } })
    expectStandardError(bad, { status: 422, code: 'VALIDATION_FAILED' })
    expect(bad.json.data.details.issues[0].path).toEqual(['amountHalalas'])
    expectStandardError(await client.request(`/api/hotels/${env.hotel.id}/booking-rules/discounts`, { cookie: env.cookie }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(url, { method: 'POST', cookie: env.cookie, body: { ...body, startDate: '2027-06-15', endDate: '2027-07-15' } }), { status: 409, code: 'RANGE_OVERLAP' })
  })

  it('reads and changes the booking settings', async () => {
    const env = await setup()
    expect((await client.request('/api/booking-settings', { cookie: env.cookie })).json).toMatchObject({ holdMinutes: 10 })
    const changed = await client.request('/api/booking-settings', { method: 'PATCH', cookie: env.cookie, body: { holdMinutes: 12 } })
    expect(changed.json).toMatchObject({ holdMinutes: 12 })
    expectStandardError(await client.request('/api/booking-settings', { method: 'PATCH', cookie: env.cookie, body: {} }), { status: 422, code: 'VALIDATION_FAILED' })
  })
})
