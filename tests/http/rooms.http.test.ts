import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { assignRole, closeTestDb, getHttpTestDb, makeFloor, makeHotel, makeLoginableUser, makeOrg, makeRole, makeRoomType, truncateAllTables } from './support/fixtures'
import { trustedHotelScope } from '../../server/security/scope'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function loginAs(permissions: string[], opts: { allHotels?: boolean, hotelIds?: string[] } = {}) {
  const { organization, scope } = await makeOrg(db)
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: opts.allHotels ?? false, hotelIds: opts.hotelIds })
  const role = await makeRole(db, scope, { permissions })
  await assignRole(db, scope, user.id, role.id)
  const login = await client.login(organization.slug, user.email, password)
  expect(login.status).toBe(200)
  return { cookie: login.cookie, organization, scope }
}

/** A real UTC hotel + floor + room type, ready for room endpoints. Dates below are computed relative to the real clock (HTTP routes use the real server clock, not an injectable one). */
async function setupHotel(scope: Awaited<ReturnType<typeof makeOrg>>['scope']) {
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
  const roomType = await makeRoomType(db, scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  return { hotel, floor, roomType }
}

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const TODAY = isoDaysFromNow(0)
const PAST = isoDaysFromNow(-3650) // safely in the past for onboarding-style creates

describe('GET/POST /api/hotels/:hotelId/rooms — auth required', () => {
  it('401 without a session', async () => {
    const res = await client.request('/api/hotels/11111111-1111-1111-1111-111111111111/rooms')
    expectStandardError(res, { status: 401 })
  })
})

describe('rooms — authorization matrix', () => {
  it('room.view can list/get but not create (403)', async () => {
    const { cookie, scope } = await loginAs(['room.view'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    const list = await client.request(`/api/hotels/${hotel.id}/rooms`, { cookie })
    expect(list.status).toBe(200)

    const createRes = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: TODAY } })
    expectStandardError(createRes, { status: 403, code: 'FORBIDDEN' })
  })

  it('room.manage can create, but base-config requires capacity.manage (403 without it)', async () => {
    const { cookie: managerCookie, scope } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    const created = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie: managerCookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: PAST } })
    expect(created.status).toBe(201)

    const baseConfigRes = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}/base-config`, { method: 'POST', cookie: managerCookie, body: { effectiveFrom: TODAY, physicalBeds: 5, sellableCapacity: 5 } })
    expectStandardError(baseConfigRes, { status: 403, code: 'FORBIDDEN' })
  })

  it('a caller WITH capacity.manage succeeds on base-config', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage', 'capacity.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)
    const created = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: PAST } })

    const res = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}/base-config`, { method: 'POST', cookie, body: { effectiveFrom: TODAY, physicalBeds: 5, sellableCapacity: 5 } })
    expect(res.status).toBe(200)
    expect(res.json.base).toEqual({ physicalBeds: 5, sellableCapacity: 5 })
  })
})

describe('rooms — foreign/inaccessible hotel and room isolation', () => {
  it('a foreign-org hotelId -> 404 on GET and POST', async () => {
    const { cookie } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const { scope: otherOrgScope } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrgScope)

    const getRes = await client.request(`/api/hotels/${foreignHotel.id}/rooms`, { cookie })
    expectStandardError(getRes, { status: 404 })

    const postRes = await client.request(`/api/hotels/${foreignHotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: '11111111-1111-1111-1111-111111111111', roomTypeId: '11111111-1111-1111-1111-111111111111', roomNumber: '401', inServiceFrom: TODAY } })
    expectStandardError(postRes, { status: 404 })
    expect(getRes.json.data.code).toBe(postRes.json.data.code)
  })

  it('a room belonging to another hotel -> 404 on GET/PATCH/retire, no write', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage', 'capacity.manage'], { allHotels: true })
    const hotelA = await makeHotel(db, scope)
    const { hotel: hotelB, floor, roomType } = await setupHotel(scope)

    const createdInB = await client.request(`/api/hotels/${hotelB.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: PAST } })
    expect(createdInB.status).toBe(201)
    const roomId = createdInB.json.id

    const getRes = await client.request(`/api/hotels/${hotelA.id}/rooms/${roomId}`, { cookie })
    expectStandardError(getRes, { status: 404 })

    const patchRes = await client.request(`/api/hotels/${hotelA.id}/rooms/${roomId}`, { method: 'PATCH', cookie, body: { notes: 'hacked' } })
    expectStandardError(patchRes, { status: 404 })

    const retireRes = await client.request(`/api/hotels/${hotelA.id}/rooms/${roomId}/retire`, { method: 'POST', cookie, body: { effectiveFrom: TODAY } })
    expectStandardError(retireRes, { status: 404 })

    const stillThere = await client.request(`/api/hotels/${hotelB.id}/rooms/${roomId}`, { cookie })
    expect(stillThere.status).toBe(200)
    expect(stillThere.json.notes).toBeNull()
  })
})

describe('rooms — validation (422)', () => {
  it('an invalid create body (bad roomNumber shape) -> 422', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    const res = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '', inServiceFrom: TODAY } })
    expectStandardError(res, { status: 422 })
  })

  it('PATCH with roomNumber -> 422 ROOM_NUMBER_IMMUTABLE specifically, and the row is unchanged', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)
    const created = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: PAST } })

    const res = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}`, { method: 'PATCH', cookie, body: { roomNumber: '999' } })
    expectStandardError(res, { status: 422, code: 'ROOM_NUMBER_IMMUTABLE' })

    const after = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}`, { cookie })
    expect(after.json.roomNumber).toBe('401')
  })

  it('PATCH with capacity/id/hotelId fields -> generic 422 VALIDATION_FAILED (strict schema)', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)
    const created = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: PAST } })

    const capacityRes = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}`, { method: 'PATCH', cookie, body: { physicalBeds: 9 } })
    expectStandardError(capacityRes, { status: 422, code: 'VALIDATION_FAILED' })

    const idRes = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}`, { method: 'PATCH', cookie, body: { id: '11111111-1111-1111-1111-111111111111' } })
    expectStandardError(idRes, { status: 422, code: 'VALIDATION_FAILED' })

    const hotelIdRes = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}`, { method: 'PATCH', cookie, body: { hotelId: '11111111-1111-1111-1111-111111111111' } })
    expectStandardError(hotelIdRes, { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('bulk create: numbers and range together -> 422; a range exceeding MAX_BULK_ROOMS -> 422; pageSize 201 on list -> 422', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    const bothRes = await client.request(`/api/hotels/${hotel.id}/rooms/bulk`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, numbers: ['401'], range: { from: 1, to: 2 } } })
    expectStandardError(bothRes, { status: 422 })

    const tooManyRes = await client.request(`/api/hotels/${hotel.id}/rooms/bulk`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, range: { from: 1, to: 201 } } })
    expectStandardError(tooManyRes, { status: 422 })

    const pageSizeRes = await client.request(`/api/hotels/${hotel.id}/rooms?pageSize=201`, { cookie })
    expectStandardError(pageSizeRes, { status: 422 })
  })

  it('asOf=2027-02-30 (calendar-invalid) -> 422', async () => {
    const { cookie, scope } = await loginAs(['room.view'], { allHotels: true })
    const { hotel } = await setupHotel(scope)

    const res = await client.request(`/api/hotels/${hotel.id}/rooms?asOf=2027-02-30`, { cookie })
    expectStandardError(res, { status: 422 })
  })
})

describe('rooms — inactive hotel write guard', () => {
  it('409 HOTEL_INACTIVE for a create against an inactive hotel', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const hotel = await makeHotel(db, scope, { status: 'INACTIVE', timezone: 'UTC' })
    const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
    const roomType = await makeRoomType(db, scope)

    const res = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: TODAY } })
    expectStandardError(res, { status: 409, code: 'HOTEL_INACTIVE' })
  })
})

describe('rooms — duplicate room number (409)', () => {
  it('creating the same room number twice in one hotel -> 409 ALREADY_EXISTS', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: TODAY } })
    const res = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: TODAY } })
    expectStandardError(res, { status: 409, code: 'ALREADY_EXISTS' })
  })
})

describe('rooms — end-to-end lifecycle over HTTP (acceptance example: Room 401, 4/4 normal)', () => {
  it('create, get, list, base-config change, retire, reactivate all work end to end', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage', 'capacity.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    const created = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: PAST } })
    expect(created.status).toBe(201)
    expect(created.json.roomNumber).toBe('401')
    expect(created.json.base).toEqual({ physicalBeds: 4, sellableCapacity: 4 })
    expect(created.json.status).toBe('AVAILABLE')

    const got = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}`, { cookie })
    expect(got.status).toBe(200)
    expect(got.json.baseVersions).toHaveLength(1)
    expect(got.json.seasons).toEqual([])

    const list = await client.request(`/api/hotels/${hotel.id}/rooms`, { cookie })
    expect(list.status).toBe(200)
    expect(list.json.items.map((r: { id: string }) => r.id)).toContain(created.json.id)

    const baseConfig = await client.request(`/api/hotels/${hotel.id}/rooms/${created.json.id}/base-config`, { method: 'POST', cookie, body: { effectiveFrom: isoDaysFromNow(30), physicalBeds: 6, sellableCapacity: 6 } })
    expect(baseConfig.status).toBe(200)
    expect(baseConfig.json.nextChange).toMatchObject({ kind: 'CAPACITY', date: isoDaysFromNow(30) })

    // A separate, freshly-created room for retire/reactivate -- effectiveFrom TODAY (immediately after
    // its own inServiceFrom, which is safely in the past) so retiring takes effect the same day.
    const roomB = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: PAST } })
    const retired = await client.request(`/api/hotels/${hotel.id}/rooms/${roomB.json.id}/retire`, { method: 'POST', cookie, body: { effectiveFrom: TODAY } })
    expect(retired.status).toBe(200)
    expect(retired.json.status).toBe('NOT_IN_INVENTORY')

    const reactivated = await client.request(`/api/hotels/${hotel.id}/rooms/${roomB.json.id}/reactivate`, { method: 'POST', cookie, body: { effectiveFrom: isoDaysFromNow(1), physicalBeds: 4, sellableCapacity: 4 } })
    expect(reactivated.status).toBe(200)
    expect(reactivated.json.status).toBe('NOT_IN_INVENTORY') // reactivation is effective TOMORROW, so today it's still out
  })

  it('bulk create via range produces the expected numbers, and PATCH updates floor/features/notes', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)
    const otherFloor = await makeFloor(db, trustedHotelScope(scope, hotel.id), { level: 9 })

    const bulk = await client.request(`/api/hotels/${hotel.id}/rooms/bulk`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, range: { prefix: '4', from: 1, to: 3, pad: 2 } } })
    expect(bulk.status).toBe(201)
    expect(bulk.json.map((r: { roomNumber: string }) => r.roomNumber).sort()).toEqual(['401', '402', '403'])

    const roomId = bulk.json[0].id
    const patch = await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}`, { method: 'PATCH', cookie, body: { floorId: otherFloor.id, features: ['CITY_VIEW'], notes: 'corner room' } })
    expect(patch.status).toBe(200)
    expect(patch.json.floor.id).toBe(otherFloor.id)
    expect(patch.json.features).toEqual(['CITY_VIEW'])
    expect(patch.json.notes).toBe('corner room')
  })

  it('Arabic-Indic room numbers are accepted end to end and normalized', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    const created = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '٤٠١', inServiceFrom: TODAY } })
    expect(created.status).toBe(201)
    expect(created.json.roomNumber).toBe('401')
  })
})
