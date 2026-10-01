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
  const { cookie } = await loginInOrg(organization, scope, permissions, opts)
  return { cookie, organization, scope }
}

/** A second (or first) login within an ALREADY-CREATED org — for tests that need two different callers sharing the same hotel. */
async function loginInOrg(organization: Awaited<ReturnType<typeof makeOrg>>['organization'], scope: Awaited<ReturnType<typeof makeOrg>>['scope'], permissions: string[], opts: { allHotels?: boolean, hotelIds?: string[] } = {}) {
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: opts.allHotels ?? false, hotelIds: opts.hotelIds })
  const role = await makeRole(db, scope, { permissions })
  await assignRole(db, scope, user.id, role.id)
  const login = await client.login(organization.slug, user.email, password)
  expect(login.status).toBe(200)
  return { cookie: login.cookie }
}

/** A real UTC hotel + floor + room type, ready for room/capacity-period endpoints. */
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

const PAST = isoDaysFromNow(-3650) // safely in the past for onboarding-style creates
const SEASON_START = isoDaysFromNow(60) // safely in the future, so the period is always FUTURE when created
const SEASON_END = isoDaysFromNow(150)

async function createRoom401(cookie: string, hotelId: string, floorId: string, roomTypeId: string) {
  const res = await client.request(`/api/hotels/${hotelId}/rooms`, { method: 'POST', cookie, body: { floorId, roomTypeId, roomNumber: '401', inServiceFrom: PAST, physicalBeds: 4, sellableCapacity: 4 } })
  expect(res.status).toBe(201)
  return res.json as { id: string }
}

describe('GET/POST /api/hotels/:hotelId/capacity-periods — auth required', () => {
  it('401 without a session', async () => {
    const res = await client.request('/api/hotels/11111111-1111-1111-1111-111111111111/capacity-periods')
    expectStandardError(res, { status: 401 })
  })
})

describe('capacity-periods — authorization matrix', () => {
  it('room.view can list periods but not create (403); preview also requires capacity.manage (403 without it)', async () => {
    const { organization, scope } = await makeOrg(db)
    const { cookie: viewerCookie } = await loginInOrg(organization, scope, ['room.view'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)

    const list = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { cookie: viewerCookie })
    expect(list.status).toBe(200)

    const createRes = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie: viewerCookie, body: { name: 'Hajj', kind: 'HAJJ', startDate: SEASON_START, endDate: SEASON_END } })
    expectStandardError(createRes, { status: 403, code: 'FORBIDDEN' })

    const { cookie: managerCookie } = await loginInOrg(organization, scope, ['room.view', 'room.manage', 'capacity.manage'], { allHotels: true, hotelIds: [hotel.id] })
    const created = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie: managerCookie, body: { name: 'Hajj', kind: 'HAJJ', startDate: SEASON_START, endDate: SEASON_END } })
    expect(created.status).toBe(201)
    const room401 = await createRoom401(managerCookie, hotel.id, floor.id, roomType.id)

    const previewRes = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${created.json.id}/overrides/preview`, {
      method: 'POST', cookie: viewerCookie, body: { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } },
    })
    expectStandardError(previewRes, { status: 403, code: 'FORBIDDEN' })
  })
})

describe('capacity-periods — foreign/inaccessible hotel and period isolation', () => {
  it('a foreign-org hotelId -> 404 on GET and POST', async () => {
    const { cookie } = await loginAs(['room.view', 'capacity.manage'], { allHotels: true })
    const { scope: otherOrgScope } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrgScope)

    const getRes = await client.request(`/api/hotels/${foreignHotel.id}/capacity-periods`, { cookie })
    expectStandardError(getRes, { status: 404 })

    const postRes = await client.request(`/api/hotels/${foreignHotel.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'X', kind: 'HAJJ', startDate: SEASON_START, endDate: SEASON_END } })
    expectStandardError(postRes, { status: 404 })
    expect(getRes.json.data.code).toBe(postRes.json.data.code)
  })

  it('a periodId belonging to another hotel (same org) -> 404 on GET/PATCH/DELETE', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage', 'capacity.manage'], { allHotels: true })
    const hotelA = await makeHotel(db, scope, { timezone: 'UTC' })
    const { hotel: hotelB } = await setupHotel(scope)

    const created = await client.request(`/api/hotels/${hotelB.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'In B', kind: 'HAJJ', startDate: SEASON_START, endDate: SEASON_END } })
    expect(created.status).toBe(201)
    const periodId = created.json.id

    const getRes = await client.request(`/api/hotels/${hotelA.id}/capacity-periods/${periodId}`, { cookie })
    expectStandardError(getRes, { status: 404 })
    const patchRes = await client.request(`/api/hotels/${hotelA.id}/capacity-periods/${periodId}`, { method: 'PATCH', cookie, body: { notes: 'hacked' } })
    expectStandardError(patchRes, { status: 404 })
    const deleteRes = await client.request(`/api/hotels/${hotelA.id}/capacity-periods/${periodId}`, { method: 'DELETE', cookie })
    expectStandardError(deleteRes, { status: 404 })
  })
})

describe('capacity-periods — validation (422)', () => {
  it('startDate after endDate -> 422; an invalid kind -> 422', async () => {
    const { cookie, scope } = await loginAs(['capacity.manage'], { allHotels: true })
    const { hotel } = await setupHotel(scope)

    const badRange = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'Bad Range', kind: 'HAJJ', startDate: SEASON_END, endDate: SEASON_START } })
    expectStandardError(badRange, { status: 422 })

    const badKind = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'Bad Kind', kind: 'NOT_A_KIND', startDate: SEASON_START, endDate: SEASON_END } })
    expectStandardError(badKind, { status: 422 })
  })

  it('two selector kinds together -> 422; an empty selector -> 422', async () => {
    const { cookie, scope } = await loginAs(['room.manage', 'capacity.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)
    const created = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'Selectors', kind: 'HAJJ', startDate: SEASON_START, endDate: SEASON_END } })

    const twoKinds = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${created.json.id}/overrides`, {
      method: 'POST', cookie, body: { selector: { floorIds: [floor.id], roomTypeIds: [roomType.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } },
    })
    expectStandardError(twoKinds, { status: 422 })

    const empty = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${created.json.id}/overrides`, {
      method: 'POST', cookie, body: { selector: {}, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } },
    })
    expectStandardError(empty, { status: 422 })
  })
})

describe('capacity-periods — end-to-end lifecycle over HTTP (acceptance example: Room 401, Hajj season)', () => {
  it('create period, apply override, GET room shows the override, capacity-timeline reflects it, preview matches apply, bulk remove works', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage', 'capacity.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)
    const room401 = await createRoom401(cookie, hotel.id, floor.id, roomType.id)

    const created = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'Hajj Season', kind: 'HAJJ', startDate: SEASON_START, endDate: SEASON_END } })
    expect(created.status).toBe(201)
    expect(created.json.phase).toBe('FUTURE')
    expect(created.json.overrideCount).toBe(0)
    const periodId = created.json.id

    const previewRes = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${periodId}/overrides/preview`, {
      method: 'POST', cookie, body: { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } },
    })
    expect(previewRes.status).toBe(200)
    expect(previewRes.json.applied).toEqual([{ roomId: room401.id, roomNumber: '401', before: { physicalBeds: 4, sellableCapacity: 4 }, after: { physicalBeds: 6, sellableCapacity: 6 } }])

    const applyRes = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${periodId}/overrides`, {
      method: 'POST', cookie, body: { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, reason: 'Hajj surge' },
    })
    expect(applyRes.status).toBe(200)
    expect(applyRes.json).toEqual({ applied: 1, skipped: [] })

    const roomDetail = await client.request(`/api/hotels/${hotel.id}/rooms/${room401.id}`, { cookie })
    expect(roomDetail.json.seasons).toHaveLength(1)
    expect(roomDetail.json.seasons[0]).toMatchObject({ physicalBeds: 6, sellableCapacity: 6, period: { id: periodId, name: 'Hajj Season' } })

    const timeline = await client.request(`/api/hotels/${hotel.id}/rooms/${room401.id}/capacity-timeline?from=${SEASON_START}&to=${SEASON_END}`, { cookie })
    expect(timeline.status).toBe(200)
    expect(timeline.json.segments).toEqual([{ from: SEASON_START, to: SEASON_END, physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE', periodId }])
    expect(Object.keys(timeline.json.refs.periods)).toEqual([periodId])

    const overridesList = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${periodId}/overrides`, { cookie })
    expect(overridesList.status).toBe(200)
    expect(overridesList.json).toHaveLength(1)
    const overrideId = overridesList.json[0].id

    const removeRes = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${periodId}/overrides/remove`, { method: 'POST', cookie, body: { overrideIds: [overrideId] } })
    expect(removeRes.status).toBe(200)
    expect(removeRes.json).toEqual({ removed: 1 })

    const afterRemove = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${periodId}/overrides`, { cookie })
    expect(afterRemove.json).toEqual([])

    const deleteRes = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${periodId}`, { method: 'DELETE', cookie })
    expect(deleteRes.status).toBe(200)
  })

  it('retiring a room with a future override -> 409 ROOM_HAS_FUTURE_OVERRIDES; deleting the single override then retiring succeeds', async () => {
    const { cookie, scope } = await loginAs(['room.view', 'room.manage', 'capacity.manage'], { allHotels: true })
    const { hotel, floor, roomType } = await setupHotel(scope)
    const room401 = await createRoom401(cookie, hotel.id, floor.id, roomType.id)
    const created = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'Retire Guard HTTP', kind: 'HAJJ', startDate: SEASON_START, endDate: SEASON_END } })
    await client.request(`/api/hotels/${hotel.id}/capacity-periods/${created.json.id}/overrides`, {
      method: 'POST', cookie, body: { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } },
    })

    const retireRes = await client.request(`/api/hotels/${hotel.id}/rooms/${room401.id}/retire`, { method: 'POST', cookie, body: { effectiveFrom: isoDaysFromNow(1) } })
    expectStandardError(retireRes, { status: 409, code: 'ROOM_HAS_FUTURE_OVERRIDES' })

    const overridesList = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${created.json.id}/overrides`, { cookie })
    const overrideId = overridesList.json[0].id
    const deleteOverrideRes = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${created.json.id}/overrides/${overrideId}`, { method: 'DELETE', cookie })
    expect(deleteOverrideRes.status).toBe(200)

    const retireAgain = await client.request(`/api/hotels/${hotel.id}/rooms/${room401.id}/retire`, { method: 'POST', cookie, body: { effectiveFrom: isoDaysFromNow(1) } })
    expect(retireAgain.status).toBe(200)
  })
})
