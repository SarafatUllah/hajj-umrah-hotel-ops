import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { assignRole, closeTestDb, getHttpTestDb, makeFloor, makeHotel, makeLoginableUser, makeOrg, makeRole, makeRoomType, truncateAllTables } from './support/fixtures'
import { trustedHotelScope } from '../../server/security/scope'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

type OrgScope = Awaited<ReturnType<typeof makeOrg>>['scope']
type Org = Awaited<ReturnType<typeof makeOrg>>['organization']

async function loginInOrg(organization: Org, scope: OrgScope, permissions: readonly string[], opts: { allHotels?: boolean, hotelIds?: string[] } = {}) {
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: opts.allHotels ?? false, hotelIds: opts.hotelIds })
  const role = await makeRole(db, scope, { permissions })
  await assignRole(db, scope, user.id, role.id)
  const login = await client.login(organization.slug, user.email, password)
  expect(login.status).toBe(200)
  return { cookie: login.cookie, user }
}

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// UTC hotels: the server's hotel-local today equals the UTC date these helpers compute.
const START = isoDaysFromNow(10)
const END = isoDaysFromNow(14)
const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions
const RECEPTION = ROLE_DEFINITIONS.RECEPTION!.permissions

/** A Hotel Manager (real cookie) with a UTC hotel, a floor, a type and Room 401 in service for years. */
async function setup() {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
  const roomType = await makeRoomType(db, scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  const { cookie, user } = await loginInOrg(organization, scope, MANAGER, { hotelIds: [hotel.id] })
  const room = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: isoDaysFromNow(-3650) } })
  expect(room.status).toBe(201)
  return { organization, scope, hotel, floor, roomType, cookie, user, roomId: room.json.id as string }
}

const blockBody = (overrides: Record<string, unknown> = {}) => ({ kind: 'MAINTENANCE', startDate: START, endDate: END, reason: 'Water leak', ...overrides })

describe('room blocks — 401 without a session (every route)', () => {
  it('GET list, POST create, POST bulk, POST cancel -> 401 with the standard error shape', async () => {
    const hotelId = '11111111-1111-1111-1111-111111111111'
    const id = '22222222-2222-2222-2222-222222222222'
    expectStandardError(await client.request(`/api/hotels/${hotelId}/room-blocks?from=${START}&to=${END}`), { status: 401 })
    expectStandardError(await client.request(`/api/hotels/${hotelId}/rooms/${id}/blocks`, { method: 'POST', body: blockBody() }), { status: 401 })
    expectStandardError(await client.request(`/api/hotels/${hotelId}/room-blocks/bulk`, { method: 'POST', body: blockBody({ roomIds: [id] }) }), { status: 401 })
    expectStandardError(await client.request(`/api/hotels/${hotelId}/room-blocks/${id}/cancel`, { method: 'POST', body: { reason: 'x' } }), { status: 401 })
  })
})

describe('room blocks — happy path over HTTP (201/200, S10/S11 DTOs, room status)', () => {
  it('create -> 201 BlockListItem; list shows it; the room shows MAINTENANCE on its first night; cancel -> 200 CANCELLED', async () => {
    const { hotel, cookie, user, roomId } = await setup()

    const created = await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}/blocks`, { method: 'POST', cookie, body: blockBody() })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({
      room: { id: roomId, roomNumber: '401' },
      kind: 'MAINTENANCE',
      startDate: START,
      endDate: END,
      nights: 5,
      reason: 'Water leak',
      phase: 'UPCOMING',
      cancelAction: 'CANCEL',
      createdBy: { id: user.id, fullName: user.fullName },
      cancelledAt: null,
      endedEarly: null,
    })

    const list = await client.request(`/api/hotels/${hotel.id}/room-blocks?from=${START}&to=${END}`, { cookie })
    expect(list.status).toBe(200)
    expect(list.json).toMatchObject({ total: 1, page: 1, items: [{ id: created.json.id }] })

    const rooms = await client.request(`/api/hotels/${hotel.id}/rooms?asOf=${START}`, { cookie })
    expect(rooms.json.items.find((r: { id: string }) => r.id === roomId).status).toBe('MAINTENANCE')

    const cancelled = await client.request(`/api/hotels/${hotel.id}/room-blocks/${created.json.id}/cancel`, { method: 'POST', cookie, body: { reason: 'Fixed' } })
    expect(cancelled.status).toBe(200)
    expect(cancelled.json).toMatchObject({ phase: 'CANCELLED', cancelReason: 'Fixed', cancelAction: null })

    const roomsAfter = await client.request(`/api/hotels/${hotel.id}/rooms?asOf=${START}`, { cookie })
    expect(roomsAfter.json.items.find((r: { id: string }) => r.id === roomId).status).toBe('AVAILABLE')
  })

  it('bulk by floor -> 201 with one block per room', async () => {
    const { hotel, floor, roomType, cookie, roomId } = await setup()
    const second = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: isoDaysFromNow(-3650) } })
    const res = await client.request(`/api/hotels/${hotel.id}/room-blocks/bulk`, { method: 'POST', cookie, body: blockBody({ kind: 'OPERATIONAL_BLOCK', floorId: floor.id }) })
    expect(res.status).toBe(201)
    expect(res.json.map((b: { room: { id: string } }) => b.room.id)).toEqual([roomId, second.json.id])
  })
})

describe('room blocks — 403 (accessible hotel, missing room.block)', () => {
  it('Reception: list -> 200; create/bulk/cancel -> 403 FORBIDDEN (even with an invalid body)', async () => {
    const { organization, scope, hotel, cookie, roomId } = await setup()
    const created = await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}/blocks`, { method: 'POST', cookie, body: blockBody() })
    const { cookie: reception } = await loginInOrg(organization, scope, RECEPTION, { hotelIds: [hotel.id] })

    expect((await client.request(`/api/hotels/${hotel.id}/room-blocks?from=${START}&to=${END}`, { cookie: reception })).status).toBe(200)
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}/blocks`, { method: 'POST', cookie: reception, body: blockBody({ kind: 'OUT_OF_SERVICE' }) }), { status: 403, code: 'FORBIDDEN' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/bulk`, { method: 'POST', cookie: reception, body: blockBody({ kind: 'OUT_OF_SERVICE', roomIds: [roomId] }) }), { status: 403, code: 'FORBIDDEN' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/${created.json.id}/cancel`, { method: 'POST', cookie: reception, body: { reason: 'x' } }), { status: 403, code: 'FORBIDDEN' })
  })
})

describe('room blocks — 404 indistinguishability', () => {
  it('a foreign-org hotel, a same-org hotel without access and a nonexistent hotel all answer the identical 404', async () => {
    const { organization, scope, hotel } = await setup()
    const inaccessible = await makeHotel(db, scope, { timezone: 'UTC' })
    const { cookie } = await loginInOrg(organization, scope, MANAGER, { hotelIds: [hotel.id] })
    const { scope: otherScope } = await makeOrg(db)
    const foreign = await makeHotel(db, otherScope, { timezone: 'UTC' })

    const responses = []
    for (const hotelId of [foreign.id, inaccessible.id, '33333333-3333-3333-3333-333333333333']) {
      const res = await client.request(`/api/hotels/${hotelId}/room-blocks?from=${START}&to=${END}`, { cookie })
      expectStandardError(res, { status: 404, code: 'HOTEL_NOT_FOUND' })
      responses.push({ status: res.status, code: res.json.data.code, message: res.json.statusMessage })
    }
    expect(new Set(responses.map(r => JSON.stringify(r))).size).toBe(1)
  })

  it('a roomId / blockId of another hotel (same org), of another org, or nonexistent -> the identical 404; nothing written', async () => {
    const a = await setup()
    const b = await setup()
    // hotel A2 in org A, accessible to a fresh org-A manager together with hotel A
    const hotelA2 = await makeHotel(db, a.scope, { timezone: 'UTC' })
    const floorA2 = await makeFloor(db, trustedHotelScope(a.scope, hotelA2.id))
    const { cookie } = await loginInOrg(a.organization, a.scope, MANAGER, { hotelIds: [a.hotel.id, hotelA2.id] })
    const roomA2 = await client.request(`/api/hotels/${hotelA2.id}/rooms`, { method: 'POST', cookie, body: { floorId: floorA2.id, roomTypeId: a.roomType.id, roomNumber: '701', inServiceFrom: isoDaysFromNow(-3650) } })
    const blockA2 = await client.request(`/api/hotels/${hotelA2.id}/rooms/${roomA2.json.id}/blocks`, { method: 'POST', cookie, body: blockBody() })
    const blockB = await client.request(`/api/hotels/${b.hotel.id}/rooms/${b.roomId}/blocks`, { method: 'POST', cookie: b.cookie, body: blockBody() })
    expect(blockA2.status).toBe(201)
    expect(blockB.status).toBe(201)

    const nonexistent = '44444444-4444-4444-4444-444444444444'
    const roomShapes = new Set<string>()
    for (const roomId of [roomA2.json.id, b.roomId, nonexistent]) {
      const res = await client.request(`/api/hotels/${a.hotel.id}/rooms/${roomId}/blocks`, { method: 'POST', cookie, body: blockBody({ kind: 'OUT_OF_SERVICE' }) })
      expectStandardError(res, { status: 404, code: 'ROOM_NOT_FOUND' })
      roomShapes.add(JSON.stringify({ code: res.json.data.code, message: res.json.statusMessage }))
    }
    expect(roomShapes.size).toBe(1)

    const blockShapes = new Set<string>()
    for (const blockId of [blockA2.json.id, blockB.json.id, nonexistent]) {
      const res = await client.request(`/api/hotels/${a.hotel.id}/room-blocks/${blockId}/cancel`, { method: 'POST', cookie, body: { reason: 'hack' } })
      expectStandardError(res, { status: 404, code: 'BLOCK_NOT_FOUND' })
      blockShapes.add(JSON.stringify({ code: res.json.data.code, message: res.json.statusMessage }))
    }
    expect(blockShapes.size).toBe(1)

    // The foreign blocks are still active (list them through their owners).
    const listA2 = await client.request(`/api/hotels/${hotelA2.id}/room-blocks?from=${START}&to=${END}`, { cookie })
    expect(listA2.json.items).toMatchObject([{ id: blockA2.json.id, phase: 'UPCOMING', cancelledAt: null }])
    const listB = await client.request(`/api/hotels/${b.hotel.id}/room-blocks?from=${START}&to=${END}`, { cookie: b.cookie })
    expect(listB.json.items).toMatchObject([{ id: blockB.json.id, cancelledAt: null }])
    const listA = await client.request(`/api/hotels/${a.hotel.id}/room-blocks?from=${START}&to=${END}&includeCancelled=true`, { cookie })
    expect(listA.json.total).toBe(0)
  })
})

describe('room blocks — 409', () => {
  it('same-kind overlap -> 409 BLOCK_OVERLAP; bulk conflict -> 409 BLOCK_CONFLICT with details.conflicts; cancel twice -> 409; retire over a block -> 409 ROOM_HAS_ACTIVE_BLOCKS', async () => {
    const { hotel, cookie, roomId } = await setup()
    const first = await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}/blocks`, { method: 'POST', cookie, body: blockBody() })
    expect(first.status).toBe(201)

    expectStandardError(await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}/blocks`, { method: 'POST', cookie, body: blockBody({ startDate: END, endDate: isoDaysFromNow(20) }) }), { status: 409, code: 'BLOCK_OVERLAP' })

    const bulk = await client.request(`/api/hotels/${hotel.id}/room-blocks/bulk`, { method: 'POST', cookie, body: blockBody({ roomIds: [roomId] }) })
    expectStandardError(bulk, { status: 409, code: 'BLOCK_CONFLICT' })
    expect(bulk.json.data.details).toEqual({ conflicts: [{ roomId, roomNumber: '401', reason: 'BLOCK_OVERLAP' }] })

    expectStandardError(await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}/retire`, { method: 'POST', cookie, body: { effectiveFrom: isoDaysFromNow(12) } }), { status: 409, code: 'ROOM_HAS_ACTIVE_BLOCKS' })

    expect((await client.request(`/api/hotels/${hotel.id}/room-blocks/${first.json.id}/cancel`, { method: 'POST', cookie, body: { reason: 'done' } })).status).toBe(200)
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/${first.json.id}/cancel`, { method: 'POST', cookie, body: { reason: 'again' } }), { status: 409, code: 'BLOCK_ALREADY_CANCELLED' })
    expect((await client.request(`/api/hotels/${hotel.id}/rooms/${roomId}/retire`, { method: 'POST', cookie, body: { effectiveFrom: isoDaysFromNow(12) } })).status).toBe(200)
  })

  it('an inactive hotel -> 409 HOTEL_INACTIVE on create', async () => {
    const { organization, scope } = await makeOrg(db)
    const hotel = await makeHotel(db, scope, { timezone: 'UTC', status: 'INACTIVE' })
    const { cookie } = await loginInOrg(organization, scope, MANAGER, { hotelIds: [hotel.id] })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/rooms/44444444-4444-4444-4444-444444444444/blocks`, { method: 'POST', cookie, body: blockBody() }), { status: 409, code: 'HOTEL_INACTIVE' })
  })
})

describe('room blocks — 422', () => {
  it('blank reason, unknown kind, endDate < startDate, unknown body keys, a start in the past, > 731 nights -> 422', async () => {
    const { hotel, cookie, roomId } = await setup()
    const url = `/api/hotels/${hotel.id}/rooms/${roomId}/blocks`
    expectStandardError(await client.request(url, { method: 'POST', cookie, body: blockBody({ reason: '   ' }) }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(url, { method: 'POST', cookie, body: blockBody({ kind: 'BOOKED' }) }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(url, { method: 'POST', cookie, body: blockBody({ startDate: END, endDate: START }) }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(url, { method: 'POST', cookie, body: blockBody({ hotelId: hotel.id }) }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(url, { method: 'POST', cookie, body: blockBody({ startDate: isoDaysFromNow(-1) }) }), { status: 422, code: 'BLOCK_IN_PAST' })
    expectStandardError(await client.request(url, { method: 'POST', cookie, body: blockBody({ startDate: isoDaysFromNow(1), endDate: isoDaysFromNow(732) }) }), { status: 422, code: 'BLOCK_TOO_LONG' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/44444444-4444-4444-4444-444444444444/cancel`, { method: 'POST', cookie, body: { reason: '' } }), { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('reason length: 501 chars -> 422 at the schema (VALIDATION_FAILED, zod stays the first line; the service REASON_TOO_LONG is defense in depth for direct callers); exactly 500 chars -> 201', async () => {
    const { hotel, cookie, roomId } = await setup()
    const url = `/api/hotels/${hotel.id}/rooms/${roomId}/blocks`
    expectStandardError(await client.request(url, { method: 'POST', cookie, body: blockBody({ reason: 'x'.repeat(501) }) }), { status: 422, code: 'VALIDATION_FAILED' })
    const ok = await client.request(url, { method: 'POST', cookie, body: blockBody({ reason: 'x'.repeat(500) }) })
    expect(ok.status).toBe(201)
    expect(ok.json.reason).toBe('x'.repeat(500))
  })

  it('bulk ids outside the hotel -> 422 INVALID_REFERENCE; both or neither selector -> 422; list window > 400 nights or missing -> 422', async () => {
    const { hotel, floor, cookie, roomId } = await setup()
    const other = await setup()
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/bulk`, { method: 'POST', cookie, body: blockBody({ roomIds: [roomId, other.roomId] }) }), { status: 422, code: 'INVALID_REFERENCE' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/bulk`, { method: 'POST', cookie, body: blockBody({ floorId: other.floor.id }) }), { status: 422, code: 'INVALID_REFERENCE' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/bulk`, { method: 'POST', cookie, body: blockBody({ roomIds: [roomId], floorId: floor.id }) }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks/bulk`, { method: 'POST', cookie, body: blockBody() }), { status: 422, code: 'VALIDATION_FAILED' })

    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks?from=${START}&to=${isoDaysFromNow(10 + 400)}`, { cookie }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks?from=${START}`, { cookie }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/room-blocks?from=${START}&to=${END}&pageSize=201`, { cookie }), { status: 422, code: 'VALIDATION_FAILED' })
    expect((await client.request(`/api/hotels/${hotel.id}/room-blocks?from=${START}&to=${isoDaysFromNow(10 + 399)}`, { cookie })).status).toBe(200)
  })
})
