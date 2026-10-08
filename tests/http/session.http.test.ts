import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import {
  assignRole,
  closeTestDb,
  getHttpTestDb,
  makeHotel,
  makeLoginableUser,
  makeOrg,
  makeRole,
  removeAllHotelAccess,
  setAllHotels,
  setUserActive,
  truncateAllTables,
} from './support/fixtures'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('GET /api/auth/me — fresh authorization (proof 3)', () => {
  it('reflects a hotel-access row removed directly from the DB, on the very next call with the same cookie', async () => {
    const { organization, scope } = await makeOrg(db)
    const hotel = await makeHotel(db, scope)
    const { user, password } = await makeLoginableUser(db, scope, { hotelIds: [hotel.id] })

    // A real assigned role (not role-less), so this same call also proves proof 3's
    // organization/roles requirement: they must cross the HTTP boundary correctly, not just be present.
    const role = await makeRole(db, scope, { key: 'HOTEL_MANAGER', name: 'Hotel Manager' })
    await assignRole(db, scope, user.id, role.id)

    const login = await client.login(organization.slug, user.email, password)
    expect(login.status).toBe(200)

    const before = await client.request('/api/auth/me', { cookie: login.cookie })
    expect(before.status).toBe(200)
    expect(before.json.hotelIds).toContain(hotel.id)

    expect(before.json.organization).toEqual({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      isDemo: organization.isDemo,
    })
    expect(before.json.roles).toEqual(
      expect.arrayContaining([{ key: role.key, name: role.name }]),
    )
    expect(before.json.roles).not.toEqual([])

    // Direct DB mutation — no service call, no re-login. Task 7's resolveAuthContext must re-query
    // every request, so the SAME cookie must see this on its very next use.
    await removeAllHotelAccess(db, scope, user.id)

    const after = await client.request('/api/auth/me', { cookie: login.cookie })
    expect(after.status).toBe(200)
    expect(after.json.hotelIds).not.toContain(hotel.id)
    expect(after.json.hotelIds).toEqual([])
  })

  it('reflects all_hotels flipped directly in the DB, on the very next call with the same cookie', async () => {
    const { organization, scope } = await makeOrg(db)
    const { user, password } = await makeLoginableUser(db, scope, { allHotels: false })

    const login = await client.login(organization.slug, user.email, password)
    expect(login.status).toBe(200)

    const before = await client.request('/api/auth/me', { cookie: login.cookie })
    expect(before.status).toBe(200)
    expect(before.json.allHotels).toBe(false)

    await setAllHotels(db, scope, user.id, true)

    const after = await client.request('/api/auth/me', { cookie: login.cookie })
    expect(after.status).toBe(200)
    expect(after.json.allHotels).toBe(true)
  })
})

describe('Deactivated user — session cannot outlive the account (proof 4)', () => {
  it('returns 401 and clears the session cookie on the next authenticated call', async () => {
    const { organization, scope } = await makeOrg(db)
    const { user, password } = await makeLoginableUser(db, scope)

    const login = await client.login(organization.slug, user.email, password)
    expect(login.status).toBe(200)

    const before = await client.request('/api/auth/me', { cookie: login.cookie })
    expect(before.status).toBe(200)

    await setUserActive(db, user.id, false)

    const after = await client.request('/api/auth/me', { cookie: login.cookie })
    expectStandardError(after, { status: 401 })

    const clearingCookie = after.setCookie.find(entry => isClearingCookie(entry))
    expect(clearingCookie, `expected a session-clearing Set-Cookie, got: ${JSON.stringify(after.setCookie)}`).toBeDefined()
  })
})

describe('Missing/tampered session (proof 5)', () => {
  it('a protected route with no cookie returns 401 in the standard error shape', async () => {
    const res = await client.request('/api/auth/me')
    expectStandardError(res, { status: 401 })
  })

  it('a protected route with a tampered cookie returns 401 in the standard error shape (never a 500)', async () => {
    const { organization, scope } = await makeOrg(db)
    const { user, password } = await makeLoginableUser(db, scope)
    const login = await client.login(organization.slug, user.email, password)
    expect(login.status).toBe(200)

    const tampered = tamperCookie(login.cookie)
    const res = await client.request('/api/auth/me', { cookie: tampered })

    expectStandardError(res, { status: 401 })
  })
})

/** Max-Age=0, an Expires date in the past, or an empty value all count as "clears the cookie". */
function isClearingCookie(setCookieEntry: string): boolean {
  const maxAgeMatch = /Max-Age=(-?\d+)/i.exec(setCookieEntry)
  if (maxAgeMatch && Number(maxAgeMatch[1]) <= 0) return true

  const expiresMatch = /Expires=([^;]+)/i.exec(setCookieEntry)
  if (expiresMatch && new Date(expiresMatch[1]!).getTime() <= Date.now()) return true

  const [, value] = /^[^=]+=([^;]*)/.exec(setCookieEntry) ?? []
  return value === ''
}

/** Corrupts a sealed session cookie's value while keeping it structurally a `name=value` cookie pair. */
function tamperCookie(cookie: string): string {
  const [name, value] = cookie.split('=')
  const corrupted = (value ?? '').split('').reverse().join('') + 'tampered'
  return `${name}=${corrupted}`
}
