import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { assignRole, closeTestDb, getHttpTestDb, makeFloor, makeHotel, makeLoginableUser, makeOrg, makeRole, makeRoomType, truncateAllTables } from './support/fixtures'
import { hotelRepos } from '../../server/repositories'
import { trustedHotelScope } from '../../server/security/scope'
import { MAX_CALENDAR_RESPONSE_BYTES, MAX_CALENDAR_ROOMS } from '../../shared/constants/inventory'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'
import { generateCalendarScaleHotel, SCALE_ROOMS } from '../support/calendarScaleHotel'

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

/** The raw response: status, exact body bytes and text (to prove no NaN/Infinity token is serialized, before any JSON.parse). */
async function raw(path: string, cookie: string): Promise<{ status: number, bytes: number, text: string }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } })
  const body = Buffer.from(await res.arrayBuffer())
  return { status: res.status, bytes: body.byteLength, text: body.toString('utf8') }
}

async function jsonRoundTrip(path: string, cookie: string) {
  const { status, text, bytes } = await raw(path, cookie)
  expect(status, text.slice(0, 500)).toBe(200)
  expect(text).not.toMatch(/NaN|Infinity/)
  const parsed = JSON.parse(text)
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  return { parsed, bytes }
}

/** A small hotel over HTTP: floor 1 with 101 (4) and 102 (5); a Hajj override on 101 and a block on 102, through the real endpoints. */
async function setup() {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const cookie = await loginInOrg(organization, scope, MANAGER, { hotelIds: [hotel.id] })
  const floor = await makeFloor(db, hotelScope, { level: 1, label: 'First' })
  const type = await makeRoomType(db, scope, { code: 'QUAD', name: 'Quad' })
  const create = async (roomNumber: string, cap: number) => {
    const res = await client.request(`/api/hotels/${hotel.id}/rooms`, { method: 'POST', cookie, body: { floorId: floor.id, roomTypeId: type.id, roomNumber, inServiceFrom: '2025-01-01', physicalBeds: cap, sellableCapacity: cap } })
    expect(res.status).toBe(201)
    return res.json.id as string
  }
  const r101 = await create('101', 4)
  const r102 = await create('102', 5)
  const period = await client.request(`/api/hotels/${hotel.id}/capacity-periods`, { method: 'POST', cookie, body: { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' } })
  expect(period.status).toBe(201)
  const apply = await client.request(`/api/hotels/${hotel.id}/capacity-periods/${period.json.id}/overrides`, { method: 'POST', cookie, body: { selector: { roomIds: [r101] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, onConflict: 'FAIL' } })
  expect(apply.status).toBeLessThan(300)
  const block = await client.request(`/api/hotels/${hotel.id}/rooms/${r102}/blocks`, { method: 'POST', cookie, body: { kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-03', endDate: '2027-06-04', reason: 'VIP group' } })
  expect(block.status).toBe(201)
  return { organization, scope, hotel, cookie, floor, type, r101, r102, periodId: period.json.id as string, blockId: block.json.id as string }
}

describe('room calendar / daily summary — 401 without a session', () => {
  it('both endpoints -> 401 with the standard error shape', async () => {
    expectStandardError(await client.request('/api/hotels/11111111-1111-1111-1111-111111111111/room-calendar?from=2027-06-01&to=2027-06-07'), { status: 401 })
    expectStandardError(await client.request('/api/hotels/11111111-1111-1111-1111-111111111111/inventory/daily-summary?from=2027-06-01&to=2027-06-07'), { status: 401 })
  })
})

describe('room calendar / daily summary — success through the real database and API', () => {
  it('segments, refs and meta; the daily summary; JSON round trip with no NaN/Infinity', async () => {
    const h = await setup()
    const { parsed } = await jsonRoundTrip(`/api/hotels/${h.hotel.id}/room-calendar?from=2027-06-01&to=2027-06-07`, h.cookie)
    expect(parsed).toMatchObject({ range: { from: '2027-06-01', to: '2027-06-07' }, page: 1, pageSize: 50, total: 2, meta: { maintenanceBlocksSales: true } })
    expect(parsed.meta.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(parsed.refs).toEqual({
      periods: { [h.periodId]: { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' } },
      blocks: { [h.blockId]: { kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-03', endDate: '2027-06-04', reason: 'VIP group' } },
    })
    expect(parsed.rooms).toEqual([
      {
        roomId: h.r101, roomNumber: '101', floor: { id: h.floor.id, level: 1, label: 'First' }, roomType: { id: h.type.id, code: 'QUAD', name: 'Quad' }, features: [],
        segments: [{ from: '2027-06-01', to: '2027-06-07', status: 'AVAILABLE', sellable: true, physicalBeds: 6, sellableCapacity: 6, capacitySource: 'PERIOD_OVERRIDE', periodId: h.periodId, blockIds: [] }],
      },
      {
        roomId: h.r102, roomNumber: '102', floor: { id: h.floor.id, level: 1, label: 'First' }, roomType: { id: h.type.id, code: 'QUAD', name: 'Quad' }, features: [],
        segments: [
          { from: '2027-06-01', to: '2027-06-02', status: 'AVAILABLE', sellable: true, physicalBeds: 5, sellableCapacity: 5, capacitySource: 'BASE', periodId: null, blockIds: [] },
          { from: '2027-06-03', to: '2027-06-04', status: 'OPERATIONAL_BLOCK', sellable: false, physicalBeds: 5, sellableCapacity: 5, capacitySource: 'BASE', periodId: null, blockIds: [h.blockId] },
          { from: '2027-06-05', to: '2027-06-07', status: 'AVAILABLE', sellable: true, physicalBeds: 5, sellableCapacity: 5, capacitySource: 'BASE', periodId: null, blockIds: [] },
        ],
      },
    ])

    const filtered = await client.request(`/api/hotels/${h.hotel.id}/room-calendar?from=2027-06-01&to=2027-06-07&status=OPERATIONAL_BLOCK&statusMatch=any&q=10&floorId=${h.floor.id}&roomTypeId=${h.type.id}&minCapacity=5&maxCapacity=5&includeOutOfInventory=false&page=1&pageSize=10`, { cookie: h.cookie })
    expect(filtered.status).toBe(200)
    expect(filtered.json.rooms.map((r: { roomNumber: string }) => r.roomNumber)).toEqual(['102'])
    expect(filtered.json.refs.periods).toEqual({})
    const past = await client.request(`/api/hotels/${h.hotel.id}/room-calendar?from=2027-06-01&to=2027-06-01&page=9`, { cookie: h.cookie })
    expect(past.status).toBe(200)
    expect(past.json).toMatchObject({ total: 2, page: 9, rooms: [] })

    const summary = await jsonRoundTrip(`/api/hotels/${h.hotel.id}/inventory/daily-summary?from=2027-06-02&to=2027-06-03&floorId=${h.floor.id}`, h.cookie)
    expect(summary.parsed).toEqual({
      range: { from: '2027-06-02', to: '2027-06-03' },
      meta: { today: parsed.meta.today, maintenanceBlocksSales: true },
      days: [
        { date: '2027-06-02', roomsInInventory: 2, sellableRooms: 2, outOfService: 0, maintenance: 0, operationalBlock: 0, effectiveSellableCapacity: 11, sellableRoomCapacity: 11 },
        { date: '2027-06-03', roomsInInventory: 2, sellableRooms: 1, outOfService: 0, maintenance: 0, operationalBlock: 1, effectiveSellableCapacity: 11, sellableRoomCapacity: 6 },
      ],
    })
  })

  it('an empty hotel: total 0 / rooms []; daily summary all zeros; an inactive hotel is readable', async () => {
    const { organization, scope } = await makeOrg(db)
    const hotel = await makeHotel(db, scope, { timezone: 'UTC', status: 'INACTIVE' })
    const cookie = await loginInOrg(organization, scope, READ_ONLY, { hotelIds: [hotel.id] })
    const cal = await jsonRoundTrip(`/api/hotels/${hotel.id}/room-calendar?from=2027-06-01&to=2027-06-30&includeOutOfInventory=true`, cookie)
    expect(cal.parsed).toMatchObject({ total: 0, rooms: [], refs: { periods: {}, blocks: {} } })
    const sum = await jsonRoundTrip(`/api/hotels/${hotel.id}/inventory/daily-summary?from=2027-06-01&to=2027-06-03`, cookie)
    expect(sum.parsed.days).toHaveLength(3)
    for (const d of sum.parsed.days) expect(d).toMatchObject({ roomsInInventory: 0, sellableRooms: 0, effectiveSellableCapacity: 0, sellableRoomCapacity: 0 })
  })
})

describe('room calendar / daily summary — 403 and 404', () => {
  it('Accountant (hotel access, no room.view) -> 403 FORBIDDEN on both endpoints', async () => {
    const h = await setup()
    const cookie = await loginInOrg(h.organization, h.scope, ACCOUNTANT, { hotelIds: [h.hotel.id] })
    expectStandardError(await client.request(`/api/hotels/${h.hotel.id}/room-calendar?from=2027-06-01&to=2027-06-07`, { cookie }), { status: 403, code: 'FORBIDDEN' })
    expectStandardError(await client.request(`/api/hotels/${h.hotel.id}/inventory/daily-summary?from=2027-06-01&to=2027-06-07`, { cookie }), { status: 403, code: 'FORBIDDEN' })
  })

  it('a foreign-org hotel, a same-org hotel without access and a nonexistent hotel answer the identical 404 (both endpoints)', async () => {
    const h = await setup()
    const inaccessible = await makeHotel(db, h.scope, { timezone: 'UTC' })
    const cookie = await loginInOrg(h.organization, h.scope, READ_ONLY, { hotelIds: [h.hotel.id] })
    const { scope: otherScope } = await makeOrg(db)
    const foreign = await makeHotel(db, otherScope, { timezone: 'UTC' })
    const seen = new Set<string>()
    for (const hotelId of [foreign.id, inaccessible.id, '33333333-3333-3333-3333-333333333333']) {
      for (const path of [`/api/hotels/${hotelId}/room-calendar?from=2027-06-01&to=2027-06-07`, `/api/hotels/${hotelId}/inventory/daily-summary?from=2027-06-01&to=2027-06-07`]) {
        const res = await client.request(path, { cookie })
        expectStandardError(res, { status: 404, code: 'HOTEL_NOT_FOUND' })
        seen.add(JSON.stringify({ status: res.status, code: res.json.data.code, message: res.json.statusMessage }))
      }
    }
    expect(seen.size).toBe(1)
    expect((await client.request(`/api/hotels/${h.hotel.id}/room-calendar?from=2027-06-01&to=2027-06-07`, { cookie })).status).toBe(200)
  })
})

describe('room calendar / daily summary — 422', () => {
  it('malformed queries, limits and the calendar-only keys on the daily summary', async () => {
    const h = await setup()
    const cal = `/api/hotels/${h.hotel.id}/room-calendar`
    const sum = `/api/hotels/${h.hotel.id}/inventory/daily-summary`
    const r = 'from=2027-06-01&to=2027-06-07'
    const cases = [
      `${cal}?from=2027-01-01&to=2028-02-05`, // 401 days
      `${cal}?from=2027-02-01&to=2027-01-31`, // from > to
      `${cal}?from=2027-02-30&to=2027-03-01`,
      `${cal}?from=2027-06-01`, // half a range
      `${cal}?to=2027-06-01`,
      `${cal}`,
      `${cal}?${r}&pageSize=201`,
      `${cal}?${r}&page=0`,
      `${cal}?${r}&status=BOGUS`,
      `${cal}?${r}&status=BOOKED`,
      `${cal}?${r}&minCapacity=-1`,
      `${cal}?${r}&minCapacity=5&maxCapacity=4`,
      `${cal}?${r}&statusMatch=some`,
      `${cal}?${r}&includeOutOfInventory=yes`,
      `${cal}?${r}&floorId=not-a-uuid`,
      `${cal}?${r}&bogus=1`,
      `${cal}?${r}&from=2027-06-02`, // repeated scalar key
      `${cal}?${r}&status=AVAILABLE&status=MAINTENANCE`,
      `${sum}?from=2027-01-01&to=2028-02-05`,
      `${sum}?from=2027-06-01`,
      `${sum}?${r}&q=1`,
      `${sum}?${r}&status=AVAILABLE`,
      `${sum}?${r}&page=1`,
      '/api/hotels/not-a-uuid/room-calendar?from=2027-06-01&to=2027-06-07',
    ]
    for (const path of cases) {
      const res = await client.request(path, { cookie: h.cookie })
      expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
      expect(JSON.stringify(res.json.data), path).not.toContain('BOGUS') // the issues never echo the rejected value (Nitro's own `url` field echoes the request path)
    }
    // The limits themselves are accepted.
    expect((await client.request(`${cal}?from=2027-01-01&to=2028-02-04&pageSize=200&minCapacity=0&maxCapacity=30`, { cookie: h.cookie })).status).toBe(200)
    expect((await client.request(`${sum}?from=2027-01-01&to=2028-02-04`, { cookie: h.cookie })).status).toBe(200)
  })

  it(`more than ${MAX_CALENDAR_ROOMS} rooms -> 422 TOO_MANY_ROOMS on every page (never truncated); a narrowing filter is served`, async () => {
    const { organization, scope } = await makeOrg(db)
    const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
    const hotelScope = trustedHotelScope(scope, hotel.id)
    const repos = hotelRepos(db, hotelScope)
    const type = await makeRoomType(db, scope)
    const [big, small] = await repos.floors.insertMany([{ level: 1, label: 'Big' }, { level: 2, label: 'Small' }])
    for (const [floorId, count, offset] of [[big!.id, MAX_CALENDAR_ROOMS, 10000], [small!.id, 1, 20000]] as const) {
      for (let start = 0; start < count; start += 1000) {
        const rooms = await repos.rooms.insertMany(Array.from({ length: Math.min(1000, count - start) }, (_, i) => ({ floorId, roomTypeId: type.id, roomNumber: String(offset + start + i), features: [], notes: null })))
        await repos.roomBaseConfigs.insertMany(rooms.map(room => ({ roomId: room.id, validFrom: '2025-01-01', validTo: null, physicalBeds: 2, sellableCapacity: 2, origin: 'SEED' })))
      }
    }
    const cookie = await loginInOrg(organization, scope, READ_ONLY, { hotelIds: [hotel.id] })
    for (const path of [`room-calendar?from=2027-06-01&to=2027-06-02`, `room-calendar?from=2027-06-01&to=2027-06-02&page=26&pageSize=200`, `inventory/daily-summary?from=2027-06-01&to=2027-06-02`]) {
      expectStandardError(await client.request(`/api/hotels/${hotel.id}/${path}`, { cookie }), { status: 422, code: 'TOO_MANY_ROOMS' })
    }
    const narrowed = await client.request(`/api/hotels/${hotel.id}/room-calendar?from=2027-06-01&to=2027-06-02&floorId=${big!.id}&pageSize=1`, { cookie })
    expect(narrowed.status).toBe(200)
    expect(narrowed.json.total).toBe(MAX_CALENDAR_ROOMS)
  }, 120_000)
})

describe('response size: the 2,000-room scale hotel (~3,600 overrides, 40,000 blocks)', () => {
  it('every 200 response stays within 2 MiB (real response bytes): the default page, 100 x 120, every 200-room page over 120 days and the 400-day summary are served; the 200 x 400 maximum is a 422 CALENDAR_RESPONSE_TOO_LARGE, and the cut-off is exact on real data', async () => {
    const { organization, scope } = await makeOrg(db)
    const generated = await db.transaction(tx => generateCalendarScaleHotel(tx, scope))
    const cookie = await loginInOrg(organization, scope, READ_ONLY, { hotelIds: [generated.hotel.id] })
    const base = `/api/hotels/${generated.hotel.id}`
    const sizes: Record<string, number> = {}

    // The default page (50 rooms) over the hotel's default 31-day window, and the 100 x 120 page.
    sizes.default50x31 = (await jsonRoundTrip(`${base}/room-calendar?from=2027-06-01&to=2027-07-01`, cookie)).bytes
    sizes.page100x120 = (await jsonRoundTrip(`${base}/room-calendar?from=2027-05-01&to=2027-08-28&pageSize=100&page=3`, cookie)).bytes

    // All 2,000 rooms at the largest page size over 120 days: ten pages, each measured.
    let rooms = 0
    let total120 = 0
    for (let page = 1; page <= SCALE_ROOMS / 200; page++) {
      const { parsed, bytes } = await jsonRoundTrip(`${base}/room-calendar?from=2027-05-01&to=2027-08-28&pageSize=200&page=${page}`, cookie)
      expect(parsed.total).toBe(SCALE_ROOMS)
      rooms += parsed.rooms.length
      total120 += bytes
      sizes[`max200x120.p${page}`] = bytes
    }
    expect(rooms).toBe(SCALE_ROOMS)
    sizes.all2000x120 = total120

    sizes.summary400 = (await jsonRoundTrip(`${base}/inventory/daily-summary?from=2027-01-01&to=2028-02-04`, cookie)).bytes

    // The largest page the API ACCEPTS as a request (200 rooms x 400 nights) is 2,369,334 bytes at this
    // density, above 2 MiB: it is refused, explicitly, with the stable code and the measured size.
    const worstPath = `${base}/room-calendar?from=2027-01-01&to=2028-02-04&pageSize=200`
    const worst = await client.request(worstPath, { cookie })
    expectStandardError(worst, { status: 422, code: 'CALENDAR_RESPONSE_TOO_LARGE' })
    expect(worst.json.data.details).toMatchObject({ limitBytes: MAX_CALENDAR_RESPONSE_BYTES, pageSize: 200 })
    expect(worst.json.data.details.bytes).toBeGreaterThan(MAX_CALENDAR_RESPONSE_BYTES)
    expect(JSON.stringify(worst.json)).not.toContain('reason') // the refusal carries no calendar data
    sizes.refused200x400 = worst.json.data.details.bytes
    // Every page of it is the same refusal at this density (never a silent partial page): the last page too.
    expectStandardError(await client.request(`${worstPath}&page=10`, { cookie }), { status: 422, code: 'CALENDAR_RESPONSE_TOO_LARGE' })
    // A narrower page of the same 400-night range is served.
    sizes.page100x400 = (await jsonRoundTrip(`${base}/room-calendar?from=2027-01-01&to=2028-02-04&pageSize=100`, cookie)).bytes

    // The cut-off on real data: with 200 rooms, the longest range whose body fits is served (<= 2 MiB)
    // and one more night is refused (> 2 MiB).
    const dayPath = (nights: number) => {
      const to = new Date(Date.UTC(2027, 0, 1) + (nights - 1) * 86_400_000).toISOString().slice(0, 10)
      return `${base}/room-calendar?from=2027-01-01&to=${to}&pageSize=200`
    }
    let fits = 120 // served (measured above, 200 x 120 pages)
    let refused = 400 // refused (above)
    while (refused - fits > 1) {
      const mid = Math.floor((fits + refused) / 2)
      const res = await raw(dayPath(mid), cookie)
      if (res.status === 200) fits = mid
      else { expect(res.status).toBe(422); refused = mid }
    }
    const atLimit = await raw(dayPath(fits), cookie)
    expect(atLimit.status).toBe(200)
    expect(atLimit.bytes).toBeLessThanOrEqual(MAX_CALENDAR_RESPONSE_BYTES)
    expect(atLimit.bytes).toBeGreaterThan(MAX_CALENDAR_RESPONSE_BYTES - 120_000) // the guard is tight: it only refuses what is really too big
    const justOver = await client.request(dayPath(refused), { cookie })
    expectStandardError(justOver, { status: 422, code: 'CALENDAR_RESPONSE_TOO_LARGE' })
    expect(justOver.json.data.details.bytes).toBeGreaterThan(MAX_CALENDAR_RESPONSE_BYTES)
    sizes.max200xNightsThatFit = atLimit.bytes

    if (process.env.PERF_REPORT) process.stdout.write(`[roomCalendar.http] bytes ${JSON.stringify(sizes)} longestRangeAt200Rooms=${fits}nights firstRefused=${refused}\n`)
    for (const [name, bytes] of Object.entries(sizes)) {
      if (name === 'all2000x120' || name === 'refused200x400') continue // the sum of ten responses / a refusal's reported size: not response bodies
      expect(bytes, name).toBeLessThanOrEqual(MAX_CALENDAR_RESPONSE_BYTES)
    }
  }, 240_000)
})
