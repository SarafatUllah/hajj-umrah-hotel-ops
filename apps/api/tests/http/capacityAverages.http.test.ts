import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { assignRole, closeTestDb, getHttpTestDb, makeFloor, makeHotel, makeLoginableUser, makeOrg, makeRole, makeRoomType, truncateAllTables } from './support/fixtures'
import { trustedHotelScope } from '../../server/security/scope'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'

const baseUrl = inject('httpTestBaseUrl')
const client = apiClient(baseUrl)
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

type OrgScope = Awaited<ReturnType<typeof makeOrg>>['scope']
type Org = Awaited<ReturnType<typeof makeOrg>>['organization']

const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions
const ACCOUNTANT = ROLE_DEFINITIONS.ACCOUNTANT!.permissions
const READ_ONLY = ROLE_DEFINITIONS.READ_ONLY_MANAGEMENT!.permissions

async function loginInOrg(organization: Org, scope: OrgScope, permissions: readonly string[], opts: { allHotels?: boolean, hotelIds?: string[] } = {}) {
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: opts.allHotels ?? false, hotelIds: opts.hotelIds })
  const role = await makeRole(db, scope, { permissions })
  await assignRole(db, scope, user.id, role.id)
  const login = await client.login(organization.slug, user.email, password)
  expect(login.status).toBe(200)
  return login.cookie
}

/** The raw response text — to prove no `NaN`/`Infinity` token is ever serialized, before any JSON.parse. */
async function rawText(path: string, cookie: string): Promise<{ status: number, text: string }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } })
  return { status: res.status, text: await res.text() }
}

/** Walks a parsed payload: every number is finite; every average has value/display null exactly when its denominator is 0. */
function expectNoNaNOrInfinity(value: unknown): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true)
    return
  }
  if (Array.isArray(value)) {
    value.forEach(expectNoNaNOrInfinity)
    return
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if ('denominator' in obj && 'value' in obj) {
      expect(obj.value === null).toBe(obj.denominator === 0)
      expect(obj.display === null).toBe(obj.denominator === 0)
    }
    Object.values(obj).forEach(expectNoNaNOrInfinity)
  }
}

async function expectJsonRoundTrip(path: string, cookie: string) {
  const { status, text } = await rawText(path, cookie)
  expect(status).toBe(200)
  expect(text).not.toMatch(/NaN|Infinity/)
  const parsed = JSON.parse(text)
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  expectNoNaNOrInfinity(parsed)
  return parsed
}

/** The requirement hotel, created over HTTP by a Hotel Manager: 25 Triples, 40 Quads, 15 Quints (bulk endpoint, room-type defaults). */
async function setup() {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const cookie = await loginInOrg(organization, scope, MANAGER, { hotelIds: [hotel.id] })
  const specs = [{ level: 1, beds: 3, from: 101, to: 125 }, { level: 2, beds: 4, from: 201, to: 240 }, { level: 3, beds: 5, from: 301, to: 315 }]
  for (const spec of specs) {
    const floor = await makeFloor(db, hotelScope, { level: spec.level })
    const type = await makeRoomType(db, scope, { defaultPhysicalBeds: spec.beds, defaultSellableCapacity: spec.beds })
    const res = await client.request(`/api/hotels/${hotel.id}/rooms/bulk`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: type.id, inServiceFrom: '2025-01-01', range: { from: spec.from, to: spec.to } } })
    expect(res.status).toBe(201)
  }
  return { organization, scope, hotel, cookie }
}

describe('capacity averages — 401 without a session', () => {
  it('both endpoints -> 401 with the standard error shape', async () => {
    expectStandardError(await client.request('/api/hotels/11111111-1111-1111-1111-111111111111/capacity/averages?date=2027-06-01'), { status: 401 })
    expectStandardError(await client.request('/api/capacity/averages'), { status: 401 })
  })
})

describe('capacity averages — the requirement example through the real database and API', () => {
  it('310 / 80 = 3.875 -> "3.88"; range and available stay; JSON round trip has no NaN/Infinity', async () => {
    const { hotel, cookie } = await setup()

    const res = await client.request(`/api/hotels/${hotel.id}/capacity/averages?date=2026-10-01`, { cookie })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      hotelId: hotel.id,
      date: '2026-10-01',
      base: { numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' },
      dateEffective: { numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' },
      range: null,
      availableStay: null,
    })

    const full = await expectJsonRoundTrip(`/api/hotels/${hotel.id}/capacity/averages?date=2027-06-01&from=2027-06-01&to=2027-06-30&stayCheckIn=2027-06-01&stayCheckOut=2027-06-05&includeRoomIds=true`, cookie)
    expect(full.range).toEqual({ from: '2027-06-01', to: '2027-06-30', numerator: 310 * 30, denominator: 80 * 30, value: 3.875, display: '3.88', basis: 'ROOM_NIGHTS' })
    expect(full.availableStay).toEqual({ checkIn: '2027-06-01', checkOut: '2027-06-05', numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS', eligibleRoomCount: 80, eligibleRoomIds: expect.any(Array) })
    expect(full.availableStay.eligibleRoomIds).toHaveLength(80)
    expect(new Set(full.availableStay.eligibleRoomIds).size).toBe(80)

    const withoutIds = await client.request(`/api/hotels/${hotel.id}/capacity/averages?stayCheckIn=2027-06-01&stayCheckOut=2027-06-05`, { cookie })
    expect(withoutIds.json.availableStay.eligibleRoomCount).toBe(80)
    expect(withoutIds.json.availableStay).not.toHaveProperty('eligibleRoomIds')
  })

  it('zero state over HTTP: an empty hotel answers 200 with null value/display (never 0, NaN, Infinity)', async () => {
    const { organization, scope } = await makeOrg(db)
    const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
    const cookie = await loginInOrg(organization, scope, READ_ONLY, { hotelIds: [hotel.id] })
    const parsed = await expectJsonRoundTrip(`/api/hotels/${hotel.id}/capacity/averages?date=2027-06-01&from=2027-06-01&to=2027-06-02&stayCheckIn=2027-06-01&stayCheckOut=2027-06-02`, cookie)
    for (const key of ['base', 'dateEffective', 'range', 'availableStay']) {
      expect(parsed[key]).toMatchObject({ numerator: 0, denominator: 0, value: null, display: null })
    }
    const org = await expectJsonRoundTrip('/api/capacity/averages?date=2027-06-01', cookie)
    expect(org.base).toEqual({ numerator: 0, denominator: 0, value: null, display: null, basis: 'ROOMS' })
  })

  it('organization endpoint: weighted sum over the caller\'s accessible hotels; JSON round trip', async () => {
    const { organization, scope, hotel } = await setup()
    const small = await makeHotel(db, scope, { timezone: 'UTC' })
    const smallFloor = await makeFloor(db, trustedHotelScope(scope, small.id))
    const six = await makeRoomType(db, scope, { defaultPhysicalBeds: 6, defaultSellableCapacity: 6 })
    const admin = await loginInOrg(organization, scope, MANAGER, { allHotels: true })
    expect((await client.request(`/api/hotels/${small.id}/rooms`, { method: 'POST', cookie: admin, body: { floorId: smallFloor.id, roomTypeId: six.id, roomNumber: '901', inServiceFrom: '2025-01-01' } })).status).toBe(201)

    const org = await expectJsonRoundTrip('/api/capacity/averages?date=2026-10-01', admin)
    expect(org.date).toBe('2026-10-01')
    expect(org.base).toEqual({ numerator: 316, denominator: 81, value: 316 / 81, display: '3.90', basis: 'ROOMS' })
    expect(org.perHotel.map((h: { hotelId: string }) => h.hotelId).sort()).toEqual([hotel.id, small.id].sort())

    const onlyOne = await client.request(`/api/capacity/averages?date=2026-10-01&hotelIds=${small.id}`, { cookie: admin })
    expect(onlyOne.status).toBe(200)
    expect(onlyOne.json.base).toMatchObject({ numerator: 6, denominator: 1, display: '6.00' })

    const noDate = await client.request('/api/capacity/averages', { cookie: admin })
    expect(noDate.status).toBe(200)
    expect(noDate.json.date).toBeNull()
  })
})

describe('capacity averages — 403', () => {
  it('Accountant (hotel access, no room.view) -> 403 FORBIDDEN on both endpoints', async () => {
    const { organization, scope, hotel } = await setup()
    const cookie = await loginInOrg(organization, scope, ACCOUNTANT, { hotelIds: [hotel.id] })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/capacity/averages`, { cookie }), { status: 403, code: 'FORBIDDEN' })
    expectStandardError(await client.request('/api/capacity/averages', { cookie }), { status: 403, code: 'FORBIDDEN' })
  })
})

describe('capacity averages — 404 indistinguishability', () => {
  it('a foreign-org hotel, a same-org hotel without access and a nonexistent hotel answer the identical 404 (both endpoints)', async () => {
    const { organization, scope, hotel } = await setup()
    const inaccessible = await makeHotel(db, scope, { timezone: 'UTC' })
    const cookie = await loginInOrg(organization, scope, READ_ONLY, { hotelIds: [hotel.id] })
    const { scope: otherScope } = await makeOrg(db)
    const foreign = await makeHotel(db, otherScope, { timezone: 'UTC' })

    const responses = []
    for (const hotelId of [foreign.id, inaccessible.id, '33333333-3333-3333-3333-333333333333']) {
      const one = await client.request(`/api/hotels/${hotelId}/capacity/averages?date=2027-06-01`, { cookie })
      expectStandardError(one, { status: 404, code: 'HOTEL_NOT_FOUND' })
      const org = await client.request(`/api/capacity/averages?hotelIds=${hotel.id},${hotelId}`, { cookie })
      expectStandardError(org, { status: 404, code: 'HOTEL_NOT_FOUND' })
      responses.push(JSON.stringify({ status: one.status, code: one.json.data.code, message: one.json.statusMessage }))
      responses.push(JSON.stringify({ status: org.status, code: org.json.data.code, message: org.json.statusMessage }))
    }
    expect(new Set(responses).size).toBe(1)

    // The caller's own hotel works, and the default organization set contains only it.
    const own = await client.request('/api/capacity/averages?date=2026-10-01', { cookie })
    expect(own.json.perHotel.map((h: { hotelId: string }) => h.hotelId)).toEqual([hotel.id])
  })
})

describe('capacity averages — 422', () => {
  it('malformed query, malformed date, range and stay limits, malformed ids', async () => {
    const { hotel, cookie } = await setup()
    const base = `/api/hotels/${hotel.id}/capacity/averages`
    const cases = [
      `${base}?bogus=1`, // unknown key (malformed query)
      `${base}?date=2027-02-30`, // calendar-invalid date
      `${base}?date=06/01/2027`, // not YYYY-MM-DD
      `${base}?from=2027-02-01&to=2027-01-31`, // from > to
      `${base}?from=2027-01-01&to=2028-02-05`, // 401 days
      `${base}?from=2027-01-01`, // half a range
      `${base}?stayCheckIn=2027-01-01&stayCheckOut=2027-04-02`, // 91 nights
      `${base}?stayCheckIn=2027-01-01&stayCheckOut=2027-01-01`, // zero nights
      `${base}?includeRoomIds=1`,
      `${base}?date=2027-06-01&date=2027-06-02`, // repeated scalar key
      '/api/hotels/not-a-uuid/capacity/averages',
      '/api/capacity/averages?hotelIds=not-a-uuid',
      '/api/capacity/averages?date=2027-02-30',
      '/api/capacity/averages?from=2027-01-01',
    ]
    for (const path of cases) {
      expectStandardError(await client.request(path, { cookie }), { status: 422, code: 'VALIDATION_FAILED' })
    }
    // The limits themselves are accepted.
    expect((await client.request(`${base}?from=2027-01-01&to=2028-02-04&stayCheckIn=2027-01-01&stayCheckOut=2027-04-01`, { cookie })).status).toBe(200)
  })
})
