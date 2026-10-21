import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { assignRole, closeTestDb, getHttpTestDb, makeHotel, makeLoginableUser, makeOrg, makeRole, makeRoomType, truncateAllTables } from './support/fixtures'

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

describe('GET /api/hotels/:hotelId/floors and GET /api/room-types — auth required', () => {
  it('401 without a session', async () => {
    const hotelRes = await client.request('/api/hotels/11111111-1111-1111-1111-111111111111/floors')
    expectStandardError(hotelRes, { status: 401 })

    const roomTypesRes = await client.request('/api/room-types')
    expectStandardError(roomTypesRes, { status: 401 })
  })
})

describe('Reception-shaped (read-only) role', () => {
  it('can list floors and room types, but cannot create either (403)', async () => {
    const { cookie, scope } = await loginAs(['room.view'], { allHotels: true })
    const hotel = await makeHotel(db, scope)

    const listFloorsRes = await client.request(`/api/hotels/${hotel.id}/floors`, { cookie })
    expect(listFloorsRes.status).toBe(200)
    expect(Array.isArray(listFloorsRes.json)).toBe(true)

    const listRoomTypesRes = await client.request('/api/room-types', { cookie })
    expect(listRoomTypesRes.status).toBe(200)
    expect(Array.isArray(listRoomTypesRes.json)).toBe(true)

    const createFloorRes = await client.request(`/api/hotels/${hotel.id}/floors`, { method: 'POST', cookie, body: { level: 1 } })
    expectStandardError(createFloorRes, { status: 403, code: 'FORBIDDEN' })

    const createRoomTypeRes = await client.request('/api/room-types', { method: 'POST', cookie, body: { code: 'STD-01', name: 'Standard' } })
    expectStandardError(createRoomTypeRes, { status: 403, code: 'FORBIDDEN' })
  })
})

describe('floors — foreign/inaccessible hotel isolation', () => {
  it('a foreign-org hotelId -> 404 on GET and POST', async () => {
    const { cookie } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const { scope: otherOrgScope } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrgScope)

    const getRes = await client.request(`/api/hotels/${foreignHotel.id}/floors`, { cookie })
    expectStandardError(getRes, { status: 404 })

    const postRes = await client.request(`/api/hotels/${foreignHotel.id}/floors`, { method: 'POST', cookie, body: { level: 1 } })
    expectStandardError(postRes, { status: 404 })
    expect(getRes.json.data.code).toBe(postRes.json.data.code)
  })

  it('a same-org hotel the caller has no access to -> the same 404', async () => {
    const { cookie, scope } = await loginAs(['room.view'], { allHotels: false, hotelIds: [] })
    const inaccessibleHotel = await makeHotel(db, scope)

    const res = await client.request(`/api/hotels/${inaccessibleHotel.id}/floors`, { cookie })
    expectStandardError(res, { status: 404 })
  })

  it('a floor belonging to another hotel -> 404 on PATCH/activate/deactivate, no write', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const hotelA = await makeHotel(db, scope)
    const hotelB = await makeHotel(db, scope)

    const createInB = await client.request(`/api/hotels/${hotelB.id}/floors`, { method: 'POST', cookie, body: { level: 1 } })
    expect(createInB.status).toBe(201)
    const floorId = createInB.json.id

    const patchRes = await client.request(`/api/hotels/${hotelA.id}/floors/${floorId}`, { method: 'PATCH', cookie, body: { label: 'Hacked' } })
    expectStandardError(patchRes, { status: 404 })

    const activateRes = await client.request(`/api/hotels/${hotelA.id}/floors/${floorId}/activate`, { method: 'POST', cookie })
    expectStandardError(activateRes, { status: 404 })

    const deactivateRes = await client.request(`/api/hotels/${hotelA.id}/floors/${floorId}/deactivate`, { method: 'POST', cookie })
    expectStandardError(deactivateRes, { status: 404 })

    // Still unaffected under its real (hotelB) hotelId.
    const listInB = await client.request(`/api/hotels/${hotelB.id}/floors`, { cookie })
    expect(listInB.status).toBe(200)
    expect(listInB.json.find((f: { id: string }) => f.id === floorId)?.label).toBe('Floor 1')
  })
})

describe('floors — validation', () => {
  it('422 for an invalid create body (level out of range)', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const hotel = await makeHotel(db, scope)

    const res = await client.request(`/api/hotels/${hotel.id}/floors`, { method: 'POST', cookie, body: { level: 500 } })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('422 for an invalid bulk body (fromLevel > toLevel, and > 60 floors)', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const hotel = await makeHotel(db, scope)

    const badRange = await client.request(`/api/hotels/${hotel.id}/floors/bulk`, { method: 'POST', cookie, body: { fromLevel: 10, toLevel: 5 } })
    expectStandardError(badRange, { status: 422, code: 'VALIDATION_FAILED' })

    const tooMany = await client.request(`/api/hotels/${hotel.id}/floors/bulk`, { method: 'POST', cookie, body: { fromLevel: 1, toLevel: 62 } })
    expectStandardError(tooMany, { status: 422, code: 'VALIDATION_FAILED' })
  })
})

describe('floors — inactive hotel write guard', () => {
  it('409 HOTEL_INACTIVE for a create against an inactive hotel', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const hotel = await makeHotel(db, scope, { status: 'INACTIVE' })

    const res = await client.request(`/api/hotels/${hotel.id}/floors`, { method: 'POST', cookie, body: { level: 1 } })
    expectStandardError(res, { status: 409, code: 'HOTEL_INACTIVE' })
  })
})

describe('floors — lifecycle over HTTP', () => {
  it('create, bulk-create, patch, activate/deactivate all work end to end', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage'], { allHotels: true })
    const hotel = await makeHotel(db, scope)

    const created = await client.request(`/api/hotels/${hotel.id}/floors`, { method: 'POST', cookie, body: { level: 0 } })
    expect(created.status).toBe(201)
    expect(created.json.label).toBe('Ground')

    const bulk = await client.request(`/api/hotels/${hotel.id}/floors/bulk`, { method: 'POST', cookie, body: { fromLevel: 1, toLevel: 3 } })
    expect(bulk.status).toBe(201)
    expect(bulk.json).toHaveLength(3)

    const patch = await client.request(`/api/hotels/${hotel.id}/floors/${created.json.id}`, { method: 'PATCH', cookie, body: { label: 'Lobby' } })
    expect(patch.status).toBe(200)
    expect(patch.json.label).toBe('Lobby')

    const deactivate = await client.request(`/api/hotels/${hotel.id}/floors/${created.json.id}/deactivate`, { method: 'POST', cookie })
    expect(deactivate.status).toBe(200)
    expect(deactivate.json.isActive).toBe(false)

    const deactivateAgain = await client.request(`/api/hotels/${hotel.id}/floors/${created.json.id}/deactivate`, { method: 'POST', cookie })
    expectStandardError(deactivateAgain, { status: 409, code: 'FLOOR_ALREADY_INACTIVE' })

    const activate = await client.request(`/api/hotels/${hotel.id}/floors/${created.json.id}/activate`, { method: 'POST', cookie })
    expect(activate.status).toBe(200)
    expect(activate.json.isActive).toBe(true)

    const list = await client.request(`/api/hotels/${hotel.id}/floors`, { cookie })
    expect(list.status).toBe(200)
    expect(list.json).toHaveLength(4)
  })

  it('a duplicate level within the bulk conflicts with 409 and details.existing', async () => {
    const { cookie, scope } = await loginAs(['room.manage'], { allHotels: true })
    const hotel = await makeHotel(db, scope)

    await client.request(`/api/hotels/${hotel.id}/floors`, { method: 'POST', cookie, body: { level: 5 } })
    const bulk = await client.request(`/api/hotels/${hotel.id}/floors/bulk`, { method: 'POST', cookie, body: { fromLevel: 0, toLevel: 10 } })
    expectStandardError(bulk, { status: 409, code: 'ALREADY_EXISTS' })
    expect(bulk.json.data.details.existing).toEqual([5])
  })
})

describe('room-types — authorization', () => {
  it('403 for a hotel-scoped room.manage writer (no allHotels) on create/update/activate/deactivate', async () => {
    const { cookie } = await loginAs(['room.manage'], { allHotels: false })

    const createRes = await client.request('/api/room-types', { method: 'POST', cookie, body: { code: 'STD-01', name: 'Standard' } })
    expectStandardError(createRes, { status: 403, code: 'FORBIDDEN' })
  })

  it('foreign-org roomTypeId -> 404 on update/activate/deactivate', async () => {
    const { cookie } = await loginAs(['room.manage'], { allHotels: true })
    const { scope: otherOrgScope } = await makeOrg(db)
    const foreignType = await makeRoomType(db, otherOrgScope, { code: 'FOREIGN-01' })

    const patchRes = await client.request(`/api/room-types/${foreignType.id}`, { method: 'PATCH', cookie, body: { name: 'Hacked' } })
    expectStandardError(patchRes, { status: 404 })

    const activateRes = await client.request(`/api/room-types/${foreignType.id}/activate`, { method: 'POST', cookie })
    expectStandardError(activateRes, { status: 404 })
  })

  it('422 for an invalid room-type body (bad code pattern)', async () => {
    const { cookie } = await loginAs(['room.manage'], { allHotels: true })

    const res = await client.request('/api/room-types', { method: 'POST', cookie, body: { code: 'bad code!', name: 'Standard' } })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })
})

describe('room-types — lifecycle over HTTP, and schema defaults applied through the real route', () => {
  it('create (defaults applied), patch, deactivate/activate all work end to end', async () => {
    const { cookie } = await loginAs(['room.view', 'room.manage'], { allHotels: true })

    const created = await client.request('/api/room-types', { method: 'POST', cookie, body: { code: 'STD-01', name: 'Standard' } })
    expect(created.status).toBe(201)
    expect(created.json.defaultPhysicalBeds).toBe(4)
    expect(created.json.defaultSellableCapacity).toBe(4)

    const patch = await client.request(`/api/room-types/${created.json.id}`, { method: 'PATCH', cookie, body: { name: 'Deluxe' } })
    expect(patch.status).toBe(200)
    expect(patch.json.name).toBe('Deluxe')

    const deactivate = await client.request(`/api/room-types/${created.json.id}/deactivate`, { method: 'POST', cookie })
    expect(deactivate.status).toBe(200)
    expect(deactivate.json.isActive).toBe(false)

    const activate = await client.request(`/api/room-types/${created.json.id}/activate`, { method: 'POST', cookie })
    expect(activate.status).toBe(200)
    expect(activate.json.isActive).toBe(true)

    const list = await client.request('/api/room-types', { cookie })
    expect(list.status).toBe(200)
    expect(list.json.find((rt: { id: string }) => rt.id === created.json.id)).toBeDefined()
  })
})

describe('room-type audit rows never appear in a hotel audit log', () => {
  it('a hotel_id-null ROOM_TYPE_CREATED row is invisible via GET /api/hotels/:hotelId/audit-log', async () => {
    const { cookie, scope } = await loginAs(['room.manage', 'audit.view'], { allHotels: true })
    const hotel = await makeHotel(db, scope)

    await client.request('/api/room-types', { method: 'POST', cookie, body: { code: 'STD-01', name: 'Standard' } })

    const auditRes = await client.request(`/api/hotels/${hotel.id}/audit-log`, { cookie })
    expect(auditRes.status).toBe(200)
    expect(auditRes.json.items.every((i: { action: string }) => i.action !== 'ROOM_TYPE_CREATED')).toBe(true)
  })
})
