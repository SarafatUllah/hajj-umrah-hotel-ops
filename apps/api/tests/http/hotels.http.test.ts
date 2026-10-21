import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { encodeAuditCursor } from '../../shared/schemas/hotel'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { assignRole, closeTestDb, getHttpTestDb, makeHotel, makeLoginableUser, makeOrg, makeRole, truncateAllTables } from './support/fixtures'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const VALID_HOTEL_BODY = { code: 'HTL-01', name: 'Al Safwah', city: 'Makkah', timezone: 'Asia/Riyadh' }

async function loginAs(permissions: string[], opts: { allHotels?: boolean, hotelIds?: string[] } = {}) {
  const { organization, scope } = await makeOrg(db)
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: opts.allHotels ?? false, hotelIds: opts.hotelIds })
  const role = await makeRole(db, scope, { permissions })
  await assignRole(db, scope, user.id, role.id)
  const login = await client.login(organization.slug, user.email, password)
  expect(login.status).toBe(200)
  return { cookie: login.cookie, organization, scope }
}

describe('GET /api/hotels — auth required', () => {
  it('401 without a session', async () => {
    const res = await client.request('/api/hotels')
    expectStandardError(res, { status: 401 })
  })
})

describe('POST /api/hotels — authorization', () => {
  it('403 for a reservation-manager-shaped role (holds some permissions but not hotel.manage+allHotels)', async () => {
    const { cookie } = await loginAs(['booking.view', 'booking.create'], { allHotels: false })

    const res = await client.request('/api/hotels', { method: 'POST', cookie, body: VALID_HOTEL_BODY })
    expectStandardError(res, { status: 403, code: 'FORBIDDEN' })
  })

  it('403 for hotel.manage without allHotels (hotel-scoped manager)', async () => {
    const { cookie } = await loginAs(['hotel.manage'], { allHotels: false })

    const res = await client.request('/api/hotels', { method: 'POST', cookie, body: VALID_HOTEL_BODY })
    expectStandardError(res, { status: 403, code: 'FORBIDDEN' })
  })

  it('422 with issues[] for a malformed body', async () => {
    const { cookie } = await loginAs(['hotel.manage'], { allHotels: true })

    const res = await client.request('/api/hotels', { method: 'POST', cookie, body: { code: 'bad code', name: '', timezone: 'Mars/Olympus' } })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
    expect(Array.isArray(res.json.data.details?.issues)).toBe(true)
    expect(res.json.data.details.issues.length).toBeGreaterThan(0)
  })

  it('201 for allHotels + hotel.manage, and the created hotel is then visible over GET', async () => {
    const { cookie } = await loginAs(['hotel.manage', 'hotel.view'], { allHotels: true })

    const created = await client.request('/api/hotels', { method: 'POST', cookie, body: VALID_HOTEL_BODY })
    expect(created.status).toBe(201)
    expect(created.json.code).toBe('HTL-01')

    const fetched = await client.request(`/api/hotels/${created.json.id}`, { cookie })
    expect(fetched.status).toBe(200)
    expect(fetched.json.id).toBe(created.json.id)
  })
})

describe('foreign-org hotelId — 404 on every hotel route', () => {
  it('GET/PATCH/activate/deactivate/settings GET+PUT/audit-log all return the same 404', async () => {
    const { cookie } = await loginAs(['hotel.view', 'hotel.manage', 'audit.view'], { allHotels: true })
    const { scope: otherOrgScope } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrgScope)

    const getRes = await client.request(`/api/hotels/${foreignHotel.id}`, { cookie })
    expectStandardError(getRes, { status: 404 })

    const patchRes = await client.request(`/api/hotels/${foreignHotel.id}`, { method: 'PATCH', cookie, body: { name: 'X' } })
    expectStandardError(patchRes, { status: 404 })

    const activateRes = await client.request(`/api/hotels/${foreignHotel.id}/activate`, { method: 'POST', cookie })
    expectStandardError(activateRes, { status: 404 })

    const deactivateRes = await client.request(`/api/hotels/${foreignHotel.id}/deactivate`, { method: 'POST', cookie })
    expectStandardError(deactivateRes, { status: 404 })

    const settingsGetRes = await client.request(`/api/hotels/${foreignHotel.id}/settings`, { cookie })
    expectStandardError(settingsGetRes, { status: 404 })

    const settingsPutRes = await client.request(`/api/hotels/${foreignHotel.id}/settings`, { method: 'PUT', cookie, body: { 'inventory.maintenanceBlocksSales': false } })
    expectStandardError(settingsPutRes, { status: 404 })

    const auditRes = await client.request(`/api/hotels/${foreignHotel.id}/audit-log`, { cookie })
    expectStandardError(auditRes, { status: 404 })

    // All identical: the caller can never distinguish "does not exist" from "exists in another org".
    expect(getRes.json.data.code).toBe(patchRes.json.data.code)
    expect(getRes.json.data.code).toBe(activateRes.json.data.code)
    expect(getRes.json.data.code).toBe(deactivateRes.json.data.code)
    expect(getRes.json.data.code).toBe(settingsGetRes.json.data.code)
    expect(getRes.json.data.code).toBe(settingsPutRes.json.data.code)
    expect(getRes.json.data.code).toBe(auditRes.json.data.code)
  })
})

describe('PATCH /api/hotels/:hotelId — mass assignment', () => {
  it('422 when the body includes status (never silently dropped or accepted)', async () => {
    const { cookie, scope } = await loginAs(['hotel.manage'], { allHotels: true })
    const target = await makeHotel(db, scope)

    const res = await client.request(`/api/hotels/${target.id}`, { method: 'PATCH', cookie, body: { status: 'INACTIVE' } })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('422 when the body includes code (immutable after creation)', async () => {
    const { cookie, scope } = await loginAs(['hotel.manage'], { allHotels: true })
    const target = await makeHotel(db, scope)

    const res = await client.request(`/api/hotels/${target.id}`, { method: 'PATCH', cookie, body: { code: 'NEW-CODE' } })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })
})

describe('hotel lifecycle and settings over HTTP', () => {
  it('activate/deactivate, settings GET/PUT, and audit-log all work end to end', async () => {
    const { cookie, scope } = await loginAs(['hotel.view', 'hotel.manage', 'audit.view'], { allHotels: true })
    const target = await makeHotel(db, scope)

    const deactivate = await client.request(`/api/hotels/${target.id}/deactivate`, { method: 'POST', cookie })
    expect(deactivate.status).toBe(200)
    expect(deactivate.json.status).toBe('INACTIVE')

    const deactivateAgain = await client.request(`/api/hotels/${target.id}/deactivate`, { method: 'POST', cookie })
    expectStandardError(deactivateAgain, { status: 409, code: 'ALREADY_INACTIVE' })

    const activate = await client.request(`/api/hotels/${target.id}/activate`, { method: 'POST', cookie })
    expect(activate.status).toBe(200)
    expect(activate.json.status).toBe('ACTIVE')

    const settingsGet = await client.request(`/api/hotels/${target.id}/settings`, { cookie })
    expect(settingsGet.status).toBe(200)
    expect(settingsGet.json['inventory.maintenanceBlocksSales']).toBe(true)

    const settingsPut = await client.request(`/api/hotels/${target.id}/settings`, { method: 'PUT', cookie, body: { 'inventory.maintenanceBlocksSales': false } })
    expect(settingsPut.status).toBe(200)
    expect(settingsPut.json['inventory.maintenanceBlocksSales']).toBe(false)

    const auditLog = await client.request(`/api/hotels/${target.id}/audit-log`, { cookie })
    expect(auditLog.status).toBe(200)
    expect(Array.isArray(auditLog.json.items)).toBe(true)
    expect(auditLog.json.items.length).toBeGreaterThan(0)
    expect('nextCursor' in auditLog.json).toBe(true)
  })

  it('422 for an unknown settings key', async () => {
    const { cookie, scope } = await loginAs(['hotel.manage'], { allHotels: true })
    const target = await makeHotel(db, scope)

    const res = await client.request(`/api/hotels/${target.id}/settings`, { method: 'PUT', cookie, body: { 'not.a.real.setting': true } })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('422 for audit-log limit=101', async () => {
    const { cookie, scope } = await loginAs(['audit.view'], { allHotels: true })
    const target = await makeHotel(db, scope)

    const res = await client.request(`/api/hotels/${target.id}/audit-log?limit=101`, { cookie })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('422 for an audit-log cursor whose createdAt half is not a valid timestamp (never reaches the repository\'s raw SQL cast as a 500)', async () => {
    const { cookie, scope } = await loginAs(['audit.view'], { allHotels: true })
    const target = await makeHotel(db, scope)
    const invalidTimestampCursor = encodeAuditCursor({ createdAt: 'not-a-timestamp', id: '11111111-1111-1111-1111-111111111111' })

    const res = await client.request(`/api/hotels/${target.id}/audit-log?cursor=${encodeURIComponent(invalidTimestampCursor)}`, { cookie })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })
})
