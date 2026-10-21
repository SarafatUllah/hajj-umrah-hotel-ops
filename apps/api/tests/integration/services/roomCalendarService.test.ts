import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../../db/schema'
import type { Database } from '../../../db/client'
import { hotelRepos } from '../../../server/repositories'
import { InventoryReadRepository, type NewRoomBaseConfig, type NewRoomCapacityOverride, type NewRoomOperationalBlock } from '../../../server/repositories/hotel'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { applyOverrides, createCapacityPeriod } from '../../../server/services/capacityPeriodService'
import { deactivateHotel, updateSettings } from '../../../server/services/hotelService'
import { cancelRoomBlock, createRoomBlock } from '../../../server/services/operationalBlockService'
import { assertCalendarResponseWithinBudget, calendarResponseBytes, getDailySummary, getRoomCalendar, type RoomCalendarDto, type RoomCalendarQueryInput } from '../../../server/services/roomCalendarService'
import { changeBaseConfig, createRoom, retireRoom } from '../../../server/services/roomService'
import { BLOCK_KINDS, type InventoryStatus, MAX_CALENDAR_RESPONSE_BYTES, MAX_CALENDAR_ROOMS } from '../../../shared/constants/inventory'
import type { Permission } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { dailySummaryQuerySchema, roomCalendarQuerySchema } from '../../../shared/schemas/roomCalendar'
import { addDays, todayInTimezone, toEpochDay } from '../../../shared/utils/dates'
import { makeCapacityPeriod, makeFloor, makeHotel, makeOrg, makeRoom, makeRoomBaseConfig, makeRoomBlock, makeRoomCapacityOverride, makeRoomType } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions as Permission[]
const ACCOUNTANT = ROLE_DEFINITIONS.ACCOUNTANT!.permissions as Permission[]
const READ_ONLY = ROLE_DEFINITIONS.READ_ONLY_MANAGEMENT!.permissions as Permission[]
/** Noon UTC on 2026-09-25: every 2027 date below is in the future for the block/period services. */
const CLOCK = () => new Date('2026-09-25T12:00:00Z')

function makeCtx(scope: OrganizationScope, opts: { permissions?: readonly Permission[], allHotels?: boolean, hotelIds?: string[], now?: () => Date, db?: Database } = {}): AuthContext {
  return {
    identity: { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'caller@test.com', fullName: 'Caller' },
    authz: { permissions: new Set(opts.permissions ?? []), allHotels: opts.allHotels ?? false, hotelIds: new Set(opts.hotelIds ?? []) },
    scope,
    db: opts.db ?? (db as Database),
    now: opts.now ?? CLOCK,
  }
}

async function hotelWithManager(scope: OrganizationScope, timezone = 'UTC') {
  const hotel = await makeHotel(db, scope, { timezone })
  const ctx = makeCtx(scope, { permissions: MANAGER, hotelIds: [hotel.id] })
  return { hotel, ctx, hotelScope: trustedHotelScope(scope, hotel.id) }
}

function calendar(ctx: AuthContext, hotelId: string, q: Partial<RoomCalendarQueryInput> & { from: string, to: string }) {
  return getRoomCalendar(ctx, hotelId, q)
}

const numbers = (r: RoomCalendarDto) => r.rooms.map(x => x.roomNumber)
const seg = (from: string, to: string, rest: Partial<RoomCalendarDto['rooms'][number]['segments'][number]>) => ({ from, to, status: 'AVAILABLE', sellable: true, capacitySource: 'BASE', periodId: null, blockIds: [], ...rest })

/** A JSON round trip leaves the payload unchanged and the text has no NaN/Infinity token. */
function expectJsonSafe(payload: unknown) {
  const text = JSON.stringify(payload)
  expect(text).not.toMatch(/NaN|Infinity/)
  expect(JSON.parse(text)).toEqual(payload)
}

/**
 * 1. The requirement's three-room example with Phase 1 states: 401 (base 4, Hajj 6/6), 402 (5/5) with
 * an OPERATIONAL_BLOCK on 06-03…06-04, 403 (6/6) with OUT_OF_SERVICE on 06-05…06-06.
 */
async function threeRoomHotel() {
  const { scope } = await makeOrg(db)
  const { hotel, ctx, hotelScope } = await hotelWithManager(scope)
  const floor = await makeFloor(db, hotelScope, { level: 4, label: 'Fourth' })
  const type = await makeRoomType(db, scope, { code: 'MIXED', name: 'Mixed', defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  const room = (n: string, cap: number, features: Array<'HARAM_VIEW' | 'ACCESSIBLE'> = []) => createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: n, inServiceFrom: '2025-01-01', physicalBeds: cap, sellableCapacity: cap, features })
  const r401 = await room('401', 4, ['HARAM_VIEW'])
  const r402 = await room('402', 5)
  const r403 = await room('403', 6, ['ACCESSIBLE'])
  const hajj = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
  await applyOverrides(ctx, hotel.id, hajj.id, { selector: { roomIds: [r401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, onConflict: 'FAIL' })
  const b402 = await createRoomBlock(ctx, hotel.id, r402.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-03', endDate: '2027-06-04', reason: 'VIP group' })
  const b403 = await createRoomBlock(ctx, hotel.id, r403.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-06-05', endDate: '2027-06-06', reason: 'Broken AC' })
  return { scope, hotel, ctx, floor, type, r401, r402, r403, hajj, b402, b403 }
}

describe('1. three-room calendar with Phase 1 states (exact segments, run-length merged)', () => {
  it('401 free at 6 (Hajj), 402 operational block on two nights, 403 out of service on two other nights', async () => {
    const h = await threeRoomHotel()
    const r = await calendar(h.ctx, h.hotel.id, { from: '2027-06-01', to: '2027-06-07' })

    expect(r).toEqual({
      range: { from: '2027-06-01', to: '2027-06-07' },
      page: 1,
      pageSize: 50,
      total: 3,
      meta: { today: '2026-09-25', maintenanceBlocksSales: true },
      refs: {
        periods: { [h.hajj.id]: { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' } },
        blocks: {
          [h.b402.id]: { kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-03', endDate: '2027-06-04', reason: 'VIP group' },
          [h.b403.id]: { kind: 'OUT_OF_SERVICE', startDate: '2027-06-05', endDate: '2027-06-06', reason: 'Broken AC' },
        },
      },
      rooms: [
        {
          roomId: h.r401.id,
          roomNumber: '401',
          floor: { id: h.floor.id, level: 4, label: 'Fourth' },
          roomType: { id: h.type.id, code: 'MIXED', name: 'Mixed' },
          features: ['HARAM_VIEW'],
          // Seven identical nights are ONE segment.
          segments: [seg('2027-06-01', '2027-06-07', { physicalBeds: 6, sellableCapacity: 6, capacitySource: 'PERIOD_OVERRIDE', periodId: h.hajj.id })],
        },
        {
          roomId: h.r402.id,
          roomNumber: '402',
          floor: { id: h.floor.id, level: 4, label: 'Fourth' },
          roomType: { id: h.type.id, code: 'MIXED', name: 'Mixed' },
          features: [],
          segments: [
            seg('2027-06-01', '2027-06-02', { physicalBeds: 5, sellableCapacity: 5 }),
            seg('2027-06-03', '2027-06-04', { status: 'OPERATIONAL_BLOCK', sellable: false, physicalBeds: 5, sellableCapacity: 5, blockIds: [h.b402.id] }),
            seg('2027-06-05', '2027-06-07', { physicalBeds: 5, sellableCapacity: 5 }),
          ],
        },
        {
          roomId: h.r403.id,
          roomNumber: '403',
          floor: { id: h.floor.id, level: 4, label: 'Fourth' },
          roomType: { id: h.type.id, code: 'MIXED', name: 'Mixed' },
          features: ['ACCESSIBLE'],
          segments: [
            seg('2027-06-01', '2027-06-04', { physicalBeds: 6, sellableCapacity: 6 }),
            seg('2027-06-05', '2027-06-06', { status: 'OUT_OF_SERVICE', sellable: false, physicalBeds: 6, sellableCapacity: 6, blockIds: [h.b403.id] }),
            seg('2027-06-07', '2027-06-07', { physicalBeds: 6, sellableCapacity: 6 }),
          ],
        },
      ],
    })
    expectJsonSafe(r)
  })

  it('the daily summary of the same rooms', async () => {
    const h = await threeRoomHotel()
    const r = await getDailySummary(h.ctx, h.hotel.id, { from: '2027-06-02', to: '2027-06-05' })
    expect(r.range).toEqual({ from: '2027-06-02', to: '2027-06-05' })
    expect(r.meta).toEqual({ today: '2026-09-25', maintenanceBlocksSales: true })
    const row = (date: string, rest: object) => ({ date, roomsInInventory: 3, outOfService: 0, maintenance: 0, operationalBlock: 0, effectiveSellableCapacity: 17, ...rest })
    expect(r.days).toEqual([
      row('2027-06-02', { sellableRooms: 3, sellableRoomCapacity: 17 }),
      row('2027-06-03', { sellableRooms: 2, operationalBlock: 1, sellableRoomCapacity: 12 }),
      row('2027-06-04', { sellableRooms: 2, operationalBlock: 1, sellableRoomCapacity: 12 }),
      row('2027-06-05', { sellableRooms: 2, outOfService: 1, sellableRoomCapacity: 11 }),
    ])
    expectJsonSafe(r)
  })
})

/**
 * 2. The filter hotel (March 2027). Floors B (-1), 1, 2; types STD and FAM.
 *   B1   (B, STD 4)
 *   101  (1, STD 4 -> 5 from 03-20)        102 (1, STD 4, MAINTENANCE 03-10…03-12)
 *   110  (1, FAM 6, OPERATIONAL_BLOCK 03-11)
 *   4    (2, STD 2)                         40  (2, FAM 6, OUT_OF_SERVICE all of March)
 *   41   (2, STD 5, in service from 04-01)  401 (2, STD 4, retired from 03-15)
 */
async function filterHotel() {
  const { scope } = await makeOrg(db)
  const { hotel, ctx, hotelScope } = await hotelWithManager(scope)
  const fB = await makeFloor(db, hotelScope, { level: -1, label: 'Basement' })
  const f1 = await makeFloor(db, hotelScope, { level: 1, label: 'First' })
  const f2 = await makeFloor(db, hotelScope, { level: 2, label: 'Second' })
  const std = await makeRoomType(db, scope, { code: 'STD', name: 'Standard' })
  const fam = await makeRoomType(db, scope, { code: 'FAM', name: 'Family', defaultPhysicalBeds: 6, defaultSellableCapacity: 6 })
  const room = (floorId: string, roomTypeId: string, n: string, cap: number, inServiceFrom = '2025-01-01') =>
    createRoom(ctx, hotel.id, { floorId, roomTypeId, roomNumber: n, inServiceFrom, physicalBeds: cap, sellableCapacity: cap, features: [] })
  const rooms = {
    B1: await room(fB.id, std.id, 'B1', 4),
    101: await room(f1.id, std.id, '101', 4),
    102: await room(f1.id, std.id, '102', 4),
    110: await room(f1.id, fam.id, '110', 6),
    4: await room(f2.id, std.id, '4', 2),
    40: await room(f2.id, fam.id, '40', 6),
    41: await room(f2.id, std.id, '41', 5, '2027-04-01'),
    401: await room(f2.id, std.id, '401', 4),
  }
  await changeBaseConfig(ctx, hotel.id, rooms[101].id, { effectiveFrom: '2027-03-20', physicalBeds: 5, sellableCapacity: 5 })
  await retireRoom(ctx, hotel.id, rooms[401].id, { effectiveFrom: '2027-03-15' })
  await createRoomBlock(ctx, hotel.id, rooms[102].id, { kind: 'MAINTENANCE', startDate: '2027-03-10', endDate: '2027-03-12', reason: 'Paint' })
  await createRoomBlock(ctx, hotel.id, rooms[110].id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-03-11', endDate: '2027-03-11', reason: 'Staff' })
  await createRoomBlock(ctx, hotel.id, rooms[40].id, { kind: 'OUT_OF_SERVICE', startDate: '2027-03-01', endDate: '2027-03-31', reason: 'Renovation' })
  return { scope, hotel, ctx, hotelScope, floors: { fB, f1, f2 }, types: { std, fam }, rooms }
}

const MARCH = { from: '2027-03-01', to: '2027-03-31' }

describe('2. every filter', () => {
  it('no filter: in-inventory rooms ordered by floor level, then natural room number; includeOutOfInventory adds the room not yet in service', async () => {
    const h = await filterHotel()
    const all = await calendar(h.ctx, h.hotel.id, MARCH)
    expect(numbers(all)).toEqual(['B1', '101', '102', '110', '4', '40', '401'])
    expect(all.total).toBe(7)
    const withOut = await calendar(h.ctx, h.hotel.id, { ...MARCH, includeOutOfInventory: true })
    expect(numbers(withOut)).toEqual(['B1', '101', '102', '110', '4', '40', '41', '401'])
    expect(withOut.rooms.find(r => r.roomNumber === '41')!.segments).toEqual([{ from: '2027-03-01', to: '2027-03-31', status: 'NOT_IN_INVENTORY', sellable: false, physicalBeds: null, sellableCapacity: null, capacitySource: null, periodId: null, blockIds: [] }])
  })

  it('floor, room type, and a foreign / unknown floor or type id (nothing, never an error that leaks)', async () => {
    const h = await filterHotel()
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, floorId: h.floors.f1.id }))).toEqual(['101', '102', '110'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, roomTypeId: h.types.fam.id }))).toEqual(['110', '40'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, floorId: h.floors.f2.id, roomTypeId: h.types.std.id }))).toEqual(['4', '401'])

    const other = await filterHotel()
    for (const q of [{ floorId: other.floors.f1.id }, { roomTypeId: other.types.std.id }, { floorId: '33333333-3333-3333-3333-333333333333' }]) {
      const r = await calendar(h.ctx, h.hotel.id, { ...MARCH, ...q })
      expect(r).toMatchObject({ total: 0, rooms: [], refs: { periods: {}, blocks: {} } })
    }
  })

  it('q is a case-insensitive room-number PREFIX: q=4 vs q=40; q=b; q=%, q=_ and q=\\ are literals (match nothing here)', async () => {
    const h = await filterHotel()
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, q: '4' }))).toEqual(['4', '40', '401'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, q: '4', includeOutOfInventory: true }))).toEqual(['4', '40', '41', '401'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, q: '40' }))).toEqual(['40', '401'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, q: '10' }))).toEqual(['101', '102'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, q: 'b' }))).toEqual(['B1'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, q: '01' }))).toEqual([]) // a prefix, never a substring
    for (const literal of ['%', '_', '\\', '4%', '4_', '%4']) {
      expect(await calendar(h.ctx, h.hotel.id, { ...MARCH, q: literal, includeOutOfInventory: true }), literal).toMatchObject({ total: 0, rooms: [] })
    }
  })

  it('q metacharacters against room numbers that really contain them (planted through the repository): matched literally, never as wildcards', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx, hotelScope } = await hotelWithManager(scope)
    const floor = await makeFloor(db, hotelScope, { level: 1 })
    const type = await makeRoomType(db, scope)
    for (const n of ['%1', 'A_1', 'AB1', '\\9', '99']) {
      const r = await makeRoom(db, hotelScope, floor.id, type.id, { roomNumber: n })
      await makeRoomBaseConfig(db, hotelScope, r.id)
    }
    const q = async (value: string) => numbers(await calendar(ctx, hotel.id, { ...MARCH, q: value }))
    expect(await q('%')).toEqual(['%1']) // a wildcard would match all five
    expect(await q('A_')).toEqual(['A_1']) // a wildcard `_` would also match AB1
    expect(await q('_')).toEqual([]) // a wildcard would match all five
    expect(await q('\\')).toEqual(['\\9']) // unescaped, `\%` would match the literal '%1' instead
    expect(await q('9')).toEqual(['99'])
  })

  it('from = to (a single date), a multi-day range, a month and a year: every row covers exactly the requested nights', async () => {
    const h = await filterHotel()
    const single = await calendar(h.ctx, h.hotel.id, { from: '2027-03-11', to: '2027-03-11' })
    expect(single.rooms.map(r => [r.roomNumber, r.segments.map(s => `${s.from}/${s.to}/${s.status}`)])).toEqual([
      ['B1', ['2027-03-11/2027-03-11/AVAILABLE']],
      ['101', ['2027-03-11/2027-03-11/AVAILABLE']],
      ['102', ['2027-03-11/2027-03-11/MAINTENANCE']],
      ['110', ['2027-03-11/2027-03-11/OPERATIONAL_BLOCK']],
      ['4', ['2027-03-11/2027-03-11/AVAILABLE']],
      ['40', ['2027-03-11/2027-03-11/OUT_OF_SERVICE']],
      ['401', ['2027-03-11/2027-03-11/AVAILABLE']],
    ])

    const multi = await calendar(h.ctx, h.hotel.id, { from: '2027-03-09', to: '2027-03-21' })
    expect(multi.rooms.find(r => r.roomNumber === '101')!.segments).toEqual([
      seg('2027-03-09', '2027-03-19', { physicalBeds: 4, sellableCapacity: 4 }),
      seg('2027-03-20', '2027-03-21', { physicalBeds: 5, sellableCapacity: 5 }),
    ])
    expect(multi.rooms.find(r => r.roomNumber === '102')!.segments.map(s => [s.from, s.to, s.status, s.sellable])).toEqual([
      ['2027-03-09', '2027-03-09', 'AVAILABLE', true],
      ['2027-03-10', '2027-03-12', 'MAINTENANCE', false],
      ['2027-03-13', '2027-03-21', 'AVAILABLE', true],
    ])

    const month = await calendar(h.ctx, h.hotel.id, MARCH)
    expect(month.rooms.find(r => r.roomNumber === '401')!.segments.map(s => [s.from, s.to, s.status])).toEqual([
      ['2027-03-01', '2027-03-14', 'AVAILABLE'],
      ['2027-03-15', '2027-03-31', 'NOT_IN_INVENTORY'],
    ])

    const year = await calendar(h.ctx, h.hotel.id, { from: '2027-01-01', to: '2027-12-31' })
    expect(numbers(year)).toEqual(['B1', '101', '102', '110', '4', '40', '41', '401'])
    expect(year.rooms.find(r => r.roomNumber === '41')!.segments.map(s => [s.from, s.to, s.status])).toEqual([
      ['2027-01-01', '2027-03-31', 'NOT_IN_INVENTORY'],
      ['2027-04-01', '2027-12-31', 'AVAILABLE'],
    ])
    for (const r of [single, multi, month, year]) {
      for (const room of r.rooms) {
        expect(room.segments[0]!.from).toBe(r.range.from)
        expect(room.segments.at(-1)!.to).toBe(r.range.to)
      }
    }
  })

  it('minCapacity / maxCapacity: effective sellable capacity on ANY night of the range', async () => {
    const h = await filterHotel()
    // 101 is 4 until 03-19 and 5 from 03-20: it matches both >= 5 and <= 4.
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, minCapacity: 5 }))).toEqual(['101', '110', '40'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, maxCapacity: 4 }))).toEqual(['B1', '101', '102', '4', '401'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, minCapacity: 4, maxCapacity: 4 }))).toEqual(['B1', '101', '102', '401'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, maxCapacity: 2 }))).toEqual(['4'])
    expect(numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, minCapacity: 7 }))).toEqual([])
    // Before 03-20 only: 101 is 4 throughout, so it no longer matches minCapacity 5.
    expect(numbers(await calendar(h.ctx, h.hotel.id, { from: '2027-03-01', to: '2027-03-19', minCapacity: 5 }))).toEqual(['110', '40'])
  })

  it('each status, statusMatch any vs all', async () => {
    const h = await filterHotel()
    const by = async (status: InventoryStatus[], extra: Partial<RoomCalendarQueryInput> = {}) => numbers(await calendar(h.ctx, h.hotel.id, { ...MARCH, status: status as never, ...extra }))
    expect(await by(['AVAILABLE'])).toEqual(['B1', '101', '102', '110', '4', '401'])
    expect(await by(['OPERATIONAL_BLOCK'])).toEqual(['110'])
    expect(await by(['MAINTENANCE'])).toEqual(['102'])
    expect(await by(['OUT_OF_SERVICE'])).toEqual(['40'])
    expect(await by(['NOT_IN_INVENTORY'])).toEqual(['401'])
    expect(await by(['NOT_IN_INVENTORY'], { includeOutOfInventory: true })).toEqual(['41', '401'])
    expect(await by(['MAINTENANCE', 'OPERATIONAL_BLOCK'])).toEqual(['102', '110'])
    expect(await by(['MAINTENANCE', 'OPERATIONAL_BLOCK'], { statusMatch: 'any' })).toEqual(['102', '110'])
    // all: every night of the range has one of the statuses.
    expect(await by(['AVAILABLE'], { statusMatch: 'all' })).toEqual(['B1', '101', '4'])
    expect(await by(['AVAILABLE', 'NOT_IN_INVENTORY'], { statusMatch: 'all' })).toEqual(['B1', '101', '4', '401'])
    expect(await by(['OUT_OF_SERVICE'], { statusMatch: 'all' })).toEqual(['40'])
    expect(await by(['NOT_IN_INVENTORY'], { statusMatch: 'all', includeOutOfInventory: true })).toEqual(['41'])
    expect(await by(['MAINTENANCE'], { statusMatch: 'all' })).toEqual([])
  })

  it('pagination happens after filtering: exact total, stable order, a page past the end is 200 with rooms [] and the same total', async () => {
    const h = await filterHotel()
    const page = async (p: number, extra: Partial<RoomCalendarQueryInput> = {}) => calendar(h.ctx, h.hotel.id, { ...MARCH, page: p, pageSize: 2, ...extra })
    const pages = [await page(1), await page(2), await page(3), await page(4)]
    expect(pages.map(numbers)).toEqual([['B1', '101'], ['102', '110'], ['4', '40'], ['401']])
    for (const p of pages) expect(p).toMatchObject({ total: 7, pageSize: 2 })
    expect(pages.map(p => p.page)).toEqual([1, 2, 3, 4])
    const past = await page(5)
    expect(past).toMatchObject({ page: 5, total: 7, rooms: [], refs: { periods: {}, blocks: {} } })
    // With a derived filter the total counts matches, not candidates.
    const filtered = await calendar(h.ctx, h.hotel.id, { ...MARCH, status: ['AVAILABLE'], page: 2, pageSize: 4 })
    expect(filtered).toMatchObject({ total: 6, page: 2 })
    expect(numbers(filtered)).toEqual(['4', '401'])
    expect((await calendar(h.ctx, h.hotel.id, { ...MARCH, minCapacity: 5, page: 1, pageSize: 1 })).total).toBe(3)
  })

  it('foreign-org, same-org inaccessible and nonexistent hotels -> the identical 404 HOTEL_NOT_FOUND (both endpoints)', async () => {
    const h = await filterHotel()
    const { scope: other } = await makeOrg(db)
    const foreign = await makeHotel(db, other)
    const sibling = await makeHotel(db, h.scope)
    for (const id of [foreign.id, sibling.id, '33333333-3333-3333-3333-333333333333']) {
      await expect(calendar(h.ctx, id, MARCH)).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404, message: 'HOTEL_NOT_FOUND' })
      await expect(getDailySummary(h.ctx, id, MARCH)).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404, message: 'HOTEL_NOT_FOUND' })
    }
  })
})

describe('3. Hajj visible in the calendar; retirement and commissioning boundaries', () => {
  it('401: 4 before 05-01, 6 (PERIOD_OVERRIDE) 05-01…07-31, 4 from 08-01; retired mid-range -> NOT_IN_INVENTORY tail; retired before the range -> omitted unless includeOutOfInventory; commissioned mid-range', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx, hotelScope } = await hotelWithManager(scope)
    const floor = await makeFloor(db, hotelScope, { level: 4 })
    const type = await makeRoomType(db, scope)
    const room = (n: string, cap: number, inServiceFrom = '2025-01-01') => createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: n, inServiceFrom, physicalBeds: cap, sellableCapacity: cap, features: [] })
    const r401 = await room('401', 4)
    const r402 = await room('402', 5)
    const r403 = await room('403', 3)
    await room('404', 2, '2027-07-15')
    const hajj = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await applyOverrides(ctx, hotel.id, hajj.id, { selector: { roomIds: [r401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, onConflict: 'FAIL' })
    await retireRoom(ctx, hotel.id, r402.id, { effectiveFrom: '2027-06-01' })
    await retireRoom(ctx, hotel.id, r403.id, { effectiveFrom: '2027-01-01' })

    const range = { from: '2027-04-29', to: '2027-08-02' }
    const r = await calendar(ctx, hotel.id, range)
    expect(numbers(r)).toEqual(['401', '402', '404'])
    const rows = new Map(r.rooms.map(x => [x.roomNumber, x.segments]))
    expect(rows.get('401')).toEqual([
      seg('2027-04-29', '2027-04-30', { physicalBeds: 4, sellableCapacity: 4 }),
      seg('2027-05-01', '2027-07-31', { physicalBeds: 6, sellableCapacity: 6, capacitySource: 'PERIOD_OVERRIDE', periodId: hajj.id }),
      seg('2027-08-01', '2027-08-02', { physicalBeds: 4, sellableCapacity: 4 }),
    ])
    const out = { status: 'NOT_IN_INVENTORY', sellable: false, physicalBeds: null, sellableCapacity: null, capacitySource: null, periodId: null, blockIds: [] }
    expect(rows.get('402')).toEqual([seg('2027-04-29', '2027-05-31', { physicalBeds: 5, sellableCapacity: 5 }), { from: '2027-06-01', to: '2027-08-02', ...out }])
    expect(rows.get('404')).toEqual([{ from: '2027-04-29', to: '2027-07-14', ...out }, seg('2027-07-15', '2027-08-02', { physicalBeds: 2, sellableCapacity: 2 })])
    expect(r.refs.periods).toEqual({ [hajj.id]: { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' } })

    const all = await calendar(ctx, hotel.id, { ...range, includeOutOfInventory: true })
    expect(numbers(all)).toEqual(['401', '402', '403', '404'])
    expect(all.rooms.find(x => x.roomNumber === '403')!.segments).toEqual([{ from: '2027-04-29', to: '2027-08-02', ...out }])

    // The last night before the retirement / the first night of service, as single dates.
    expect((await calendar(ctx, hotel.id, { from: '2027-05-31', to: '2027-05-31' })).rooms.map(x => x.roomNumber)).toEqual(['401', '402'])
    expect((await calendar(ctx, hotel.id, { from: '2027-06-01', to: '2027-06-01' })).rooms.map(x => x.roomNumber)).toEqual(['401'])
    expect((await calendar(ctx, hotel.id, { from: '2027-07-14', to: '2027-07-14' })).rooms.map(x => x.roomNumber)).toEqual(['401'])
    expect((await calendar(ctx, hotel.id, { from: '2027-07-15', to: '2027-07-15' })).rooms.map(x => x.roomNumber)).toEqual(['401', '404'])

    const summary = await getDailySummary(ctx, hotel.id, { from: '2027-04-30', to: '2027-05-01' })
    expect(summary.days.map(d => [d.date, d.roomsInInventory, d.effectiveSellableCapacity])).toEqual([['2027-04-30', 2, 9], ['2027-05-01', 2, 11]])
  })
})

describe('4. inventory.maintenanceBlocksSales = false', () => {
  it('MAINTENANCE stays MAINTENANCE but sellable; the daily summary counts it in maintenance AND sellableRooms (true: only in maintenance)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx, hotelScope } = await hotelWithManager(scope)
    const floor = await makeFloor(db, hotelScope)
    const type = await makeRoomType(db, scope)
    const a = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: '101', inServiceFrom: '2025-01-01', physicalBeds: 4, sellableCapacity: 4, features: [] })
    const b = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: '102', inServiceFrom: '2025-01-01', physicalBeds: 3, sellableCapacity: 3, features: [] })
    const m = await createRoomBlock(ctx, hotel.id, a.id, { kind: 'MAINTENANCE', startDate: '2027-02-02', endDate: '2027-02-03', reason: 'Paint' })
    await createRoomBlock(ctx, hotel.id, b.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-02-03', endDate: '2027-02-03', reason: 'Leak' })
    const range = { from: '2027-02-01', to: '2027-02-03' }

    const before = await calendar(ctx, hotel.id, range)
    expect(before.meta.maintenanceBlocksSales).toBe(true)
    expect(before.rooms[0]!.segments[1]).toEqual(seg('2027-02-02', '2027-02-03', { status: 'MAINTENANCE', sellable: false, physicalBeds: 4, sellableCapacity: 4, blockIds: [m.id] }))
    const beforeSummary = await getDailySummary(ctx, hotel.id, range)
    expect(beforeSummary.days[1]).toMatchObject({ date: '2027-02-02', maintenance: 1, sellableRooms: 1, sellableRoomCapacity: 3, effectiveSellableCapacity: 7 })

    await updateSettings(ctx, hotel.id, { 'inventory.maintenanceBlocksSales': false })
    const after = await calendar(ctx, hotel.id, range)
    expect(after.meta.maintenanceBlocksSales).toBe(false)
    expect(after.rooms[0]!.segments).toEqual([
      seg('2027-02-01', '2027-02-01', { physicalBeds: 4, sellableCapacity: 4 }),
      seg('2027-02-02', '2027-02-03', { status: 'MAINTENANCE', sellable: true, physicalBeds: 4, sellableCapacity: 4, blockIds: [m.id] }),
    ])
    const summary = await getDailySummary(ctx, hotel.id, range)
    expect(summary.meta.maintenanceBlocksSales).toBe(false)
    expect(summary.days).toEqual([
      { date: '2027-02-01', roomsInInventory: 2, sellableRooms: 2, outOfService: 0, maintenance: 0, operationalBlock: 0, effectiveSellableCapacity: 7, sellableRoomCapacity: 7 },
      { date: '2027-02-02', roomsInInventory: 2, sellableRooms: 2, outOfService: 0, maintenance: 1, operationalBlock: 0, effectiveSellableCapacity: 7, sellableRoomCapacity: 7 },
      { date: '2027-02-03', roomsInInventory: 2, sellableRooms: 1, outOfService: 1, maintenance: 1, operationalBlock: 0, effectiveSellableCapacity: 7, sellableRoomCapacity: 4 },
    ])
    // The status filter still sees MAINTENANCE.
    expect(numbers(await calendar(ctx, hotel.id, { ...range, status: ['MAINTENANCE'] }))).toEqual(['101'])
  })
})

/**
 * A generated hotel written through the repositories: 3 floors x 2 types, 90 rooms; every 9th room has
 * a base change on 2027-04-01, every 11th is retired after 2027-05-31, every 13th is commissioned
 * 2027-03-01, every 17th was retired before 2027; two capacity periods with overrides; three blocks
 * per room of rotating kinds (two may overlap, different kinds), every 5th room's first block cancelled.
 */
async function generatedHotel(scope: OrganizationScope) {
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const repos = hotelRepos(db, hotelScope)
  const types = [await makeRoomType(db, scope), await makeRoomType(db, scope)]
  const floors = await repos.floors.insertMany([1, 2, 3].map(level => ({ level, label: `Floor ${level}` })))
  const rooms = await repos.rooms.insertMany(Array.from({ length: 90 }, (_, i) => ({ floorId: floors[i % 3]!.id, roomTypeId: types[i % 2]!.id, roomNumber: String(100 * (1 + (i % 3)) + i), features: [], notes: null })))
  const cap = (i: number) => 2 + (i % 5)
  const versions: NewRoomBaseConfig[] = rooms.flatMap((room, i) => {
    if (i % 17 === 0) return [{ roomId: room.id, validFrom: '2025-01-01', validTo: '2026-12-31', physicalBeds: cap(i), sellableCapacity: cap(i), origin: 'SEED' }]
    if (i % 13 === 0) return [{ roomId: room.id, validFrom: '2027-03-01', validTo: null, physicalBeds: cap(i), sellableCapacity: cap(i), origin: 'SEED' }]
    if (i % 11 === 0) return [{ roomId: room.id, validFrom: '2025-01-01', validTo: '2027-05-31', physicalBeds: cap(i), sellableCapacity: cap(i), origin: 'SEED' }]
    if (i % 9 === 0) {
      return [
        { roomId: room.id, validFrom: '2025-01-01', validTo: '2027-03-31', physicalBeds: cap(i), sellableCapacity: cap(i), origin: 'SEED' },
        { roomId: room.id, validFrom: '2027-04-01', validTo: null, physicalBeds: cap(i) + 1, sellableCapacity: cap(i), origin: 'SEED' },
      ]
    }
    return [{ roomId: room.id, validFrom: '2025-01-01', validTo: null, physicalBeds: cap(i), sellableCapacity: cap(i), origin: 'SEED' }]
  })
  await repos.roomBaseConfigs.insertMany(versions)
  const inService = (i: number) => i % 17 !== 0 && i % 13 !== 0 && i % 11 !== 0
  const periods = [
    await repos.capacityPeriods.insert({ name: 'Ramadan', kind: 'RAMADAN', startDate: '2027-02-08', endDate: '2027-03-09', notes: null }),
    await repos.capacityPeriods.insert({ name: 'Hajj', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31', notes: null }),
  ]
  const overrides: NewRoomCapacityOverride[] = []
  rooms.forEach((room, i) => {
    if (!inService(i)) return
    if (i % 2 === 0) overrides.push({ roomId: room.id, periodId: periods[0]!.id, validFrom: '2027-02-08', validTo: '2027-03-09', physicalBeds: 6, sellableCapacity: 5, reason: null })
    if (i % 3 !== 0) overrides.push({ roomId: room.id, periodId: periods[1]!.id, validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: 7, sellableCapacity: 7, reason: null })
  })
  await repos.roomCapacityOverrides.insertMany(overrides)
  const blocks: NewRoomOperationalBlock[] = rooms.flatMap((room, i) => {
    if (!inService(i)) return []
    return [0, 1, 2].map((k) => {
      const start = addDays('2027-01-10', k * 50 + (i % 20))
      return { roomId: room.id, kind: BLOCK_KINDS[(i + k) % 3]!, startDate: start, endDate: addDays(start, k === 1 ? 30 : 3), reason: `Generated ${i}/${k}` }
    })
  })
  const insertedBlocks = await repos.operationalBlocks.insertMany(blocks)
  // An overlapping block of a different kind on some rooms (allowed: the exclusion is per kind).
  const extra = await repos.operationalBlocks.insertMany(blocks.filter((_, j) => j % 7 === 0).map(b => ({ ...b, kind: BLOCK_KINDS[(BLOCK_KINDS.indexOf(b.kind as never) + 1) % 3]!, startDate: addDays(b.startDate, 1), endDate: addDays(b.startDate, 2) })))
  const cancelled = insertedBlocks.filter((_, j) => j % 15 === 0)
  for (const b of cancelled) await repos.operationalBlocks.markCancelled(b.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'Generated')
  const cancelledIds = new Set(cancelled.map(b => b.id))
  const activeBlocks = [...insertedBlocks, ...extra].filter(b => !cancelledIds.has(b.id))
  return { hotel, hotelScope, floors, types, rooms, versions, overrides, activeBlocks, cancelledIds }
}

type Generated = Awaited<ReturnType<typeof generatedHotel>>

/** An independent per-night oracle over the generated rows (written from the rules, not from the domain code). */
function oracleNight(g: Generated, roomId: string, night: string, maintenanceBlocksSales: boolean) {
  const v = g.versions.find(x => x.roomId === roomId && x.validFrom <= night && (x.validTo == null || x.validTo >= night))
  if (!v) return { status: 'NOT_IN_INVENTORY', sellable: false, cap: null as number | null }
  const o = g.overrides.find(x => x.roomId === roomId && x.validFrom <= night && x.validTo >= night)
  const kinds = new Set(g.activeBlocks.filter(b => b.roomId === roomId && b.startDate <= night && b.endDate >= night).map(b => b.kind))
  const status = kinds.has('OUT_OF_SERVICE') ? 'OUT_OF_SERVICE' : kinds.has('MAINTENANCE') ? 'MAINTENANCE' : kinds.has('OPERATIONAL_BLOCK') ? 'OPERATIONAL_BLOCK' : 'AVAILABLE'
  const sellable = !kinds.has('OUT_OF_SERVICE') && !kinds.has('OPERATIONAL_BLOCK') && (!kinds.has('MAINTENANCE') || !maintenanceBlocksSales)
  return { status, sellable, cap: (o ?? v).sellableCapacity }
}

const nightsOf = (from: string, to: string) => {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

async function wholeCalendar(ctx: AuthContext, hotelId: string, q: Partial<RoomCalendarQueryInput> & { from: string, to: string }) {
  const rooms: RoomCalendarDto['rooms'] = []
  let total: number
  for (let page = 1; ; page++) {
    const r = await calendar(ctx, hotelId, { ...q, page, pageSize: 200 })
    total = r.total
    rooms.push(...r.rooms)
    if (r.rooms.length === 0 || rooms.length >= total) break
  }
  expect(rooms).toHaveLength(total)
  return rooms
}

describe('5. invariants over a generated hotel', () => {
  it('segments tile the range exactly (no gap / overlap, adjacent segments differ); every night matches an independent oracle; the daily summary equals an independent aggregation of the calendar', async () => {
    const { scope } = await makeOrg(db)
    const g = await generatedHotel(scope)
    const ctx = makeCtx(scope, { permissions: READ_ONLY, allHotels: true })
    expect(g.cancelledIds.size).toBeGreaterThan(0)

    const ranges = [
      { from: '2027-03-05', to: '2027-03-05' },
      { from: '2027-02-01', to: '2027-03-15' },
      { from: '2027-01-01', to: '2027-12-31' },
      { from: '2027-01-01', to: '2028-02-04' }, // 400 nights
    ]
    for (const range of ranges) {
      for (const structural of [{}, { floorId: g.floors[1]!.id }, { roomTypeId: g.types[0]!.id }]) {
        const rooms = await wholeCalendar(ctx, g.hotel.id, { ...range, ...structural, includeOutOfInventory: true })
        const length = toEpochDay(range.to) - toEpochDay(range.from) + 1
        const expectedIds = g.rooms.filter(r => (!('floorId' in structural) || r.floorId === structural.floorId) && (!('roomTypeId' in structural) || r.roomTypeId === structural.roomTypeId)).map(r => r.id)
        expect(new Set(rooms.map(r => r.roomId))).toEqual(new Set(expectedIds))

        const perNight = new Map<string, { inInv: number, sellable: number, oos: number, maint: number, op: number, cap: number, sellCap: number }>()
        for (const night of nightsOf(range.from, range.to)) perNight.set(night, { inInv: 0, sellable: 0, oos: 0, maint: 0, op: 0, cap: 0, sellCap: 0 })
        for (const room of rooms) {
          const segs = room.segments
          const actual: object[] = []
          const expected: object[] = []
          expect(segs[0]!.from).toBe(range.from)
          expect(segs.at(-1)!.to).toBe(range.to)
          let covered = 0
          segs.forEach((s, k) => {
            expect(toEpochDay(s.to)).toBeGreaterThanOrEqual(toEpochDay(s.from))
            covered += toEpochDay(s.to) - toEpochDay(s.from) + 1
            if (k > 0) {
              expect(toEpochDay(segs[k - 1]!.to) + 1).toBe(toEpochDay(s.from))
              expect(JSON.stringify({ ...segs[k - 1], from: 0, to: 0 })).not.toBe(JSON.stringify({ ...s, from: 0, to: 0 })) // run-length: neighbours differ
            }
            for (const night of nightsOf(s.from, s.to)) {
              actual.push({ night, status: s.status, sellable: s.sellable, cap: s.sellableCapacity })
              expected.push({ night, ...oracleNight(g, room.roomId, night, true) })
              // Independent aggregation of the calendar for the daily summary.
              if (s.status === 'NOT_IN_INVENTORY') continue
              const acc = perNight.get(night)!
              acc.inInv++
              acc.cap += s.sellableCapacity!
              if (s.sellable) { acc.sellable++; acc.sellCap += s.sellableCapacity! }
              if (s.status === 'OUT_OF_SERVICE') acc.oos++
              if (s.status === 'MAINTENANCE') acc.maint++
              if (s.status === 'OPERATIONAL_BLOCK') acc.op++
            }
          })
          expect(covered).toBe(length)
          expect(actual).toEqual(expected)
        }

        const summary = await getDailySummary(ctx, g.hotel.id, { ...range, ...structural })
        expect(summary.days).toHaveLength(length)
        expect(summary.days.map(d => [d.date, d.roomsInInventory, d.sellableRooms, d.outOfService, d.maintenance, d.operationalBlock, d.effectiveSellableCapacity, d.sellableRoomCapacity]))
          .toEqual([...perNight.entries()].map(([date, a]) => [date, a.inInv, a.sellable, a.oos, a.maint, a.op, a.cap, a.sellCap]))
      }
    }
  }, 120_000)
})

describe('6. validation', () => {
  it('schema: 401 days, from > to, 2027-02-30, pageSize=201, page=0, status=BOGUS, minCapacity=-1, statusMatch=some, half a range, min > max, unknown key, Phase 2 statuses, repeated keys', () => {
    const ok = (q: Record<string, unknown>) => expect(roomCalendarQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(true)
    const bad = (q: Record<string, unknown>) => expect(roomCalendarQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false)
    const range = { from: '2027-01-01', to: '2027-01-31' }
    ok(range)
    ok({ from: '2027-01-01', to: '2028-02-04' }) // 400 days
    ok({ from: '2027-01-01', to: '2027-01-01' })
    bad({ from: '2027-01-01', to: '2028-02-05' }) // 401 days
    bad({ from: '2027-02-01', to: '2027-01-31' })
    bad({ from: '2027-02-30', to: '2027-03-01' })
    bad({ from: '2027-01-01', to: '2027-02-30' })
    bad({ from: '2027-01-01' })
    bad({ to: '2027-01-01' })
    bad({})
    bad({ ...range, pageSize: '201' })
    bad({ ...range, pageSize: '0' })
    bad({ ...range, page: '0' })
    bad({ ...range, page: '-1' })
    bad({ ...range, page: '1.5' })
    bad({ ...range, page: '' })
    bad({ ...range, status: 'BOGUS' })
    bad({ ...range, status: 'AVAILABLE,BOGUS' })
    bad({ ...range, status: '' })
    for (const phase2 of ['OCCUPIED', 'BOOKED', 'HELD']) bad({ ...range, status: phase2 })
    bad({ ...range, status: ['AVAILABLE', 'MAINTENANCE'] }) // repeated key
    bad({ ...range, minCapacity: '-1' })
    bad({ ...range, minCapacity: '' })
    bad({ ...range, maxCapacity: '31' })
    bad({ ...range, minCapacity: '5', maxCapacity: '4' })
    ok({ ...range, minCapacity: '4', maxCapacity: '4' })
    bad({ ...range, statusMatch: 'some' })
    bad({ ...range, includeOutOfInventory: '1' })
    bad({ ...range, floorId: 'not-a-uuid' })
    bad({ ...range, q: 'x'.repeat(41) })
    bad({ ...range, from: ['2027-01-01', '2027-01-02'] })
    bad({ ...range, bogus: '1' })
    bad({ ...range, hotelId: '11111111-1111-1111-1111-111111111111' })

    expect(roomCalendarQuerySchema.parse(range)).toEqual({ ...range, statusMatch: 'any', includeOutOfInventory: false, page: 1, pageSize: 50 })
    expect(roomCalendarQuerySchema.parse({ ...range, status: 'MAINTENANCE, AVAILABLE,MAINTENANCE', statusMatch: 'all', includeOutOfInventory: 'true', page: '3', pageSize: '200', minCapacity: '0', maxCapacity: '30' }))
      .toEqual({ ...range, status: ['MAINTENANCE', 'AVAILABLE'], statusMatch: 'all', includeOutOfInventory: true, page: 3, pageSize: 200, minCapacity: 0, maxCapacity: 30 })

    // The daily summary takes the range and the structural floor/type filters ONLY.
    expect(dailySummaryQuerySchema.safeParse({ ...range, floorId: '11111111-1111-4111-8111-111111111111', roomTypeId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true)
    for (const extra of [{ q: '4' }, { status: 'AVAILABLE' }, { minCapacity: '1' }, { page: '1' }, { pageSize: '10' }, { includeOutOfInventory: 'true' }, { statusMatch: 'any' }]) {
      expect(dailySummaryQuerySchema.safeParse({ ...range, ...extra }).success, JSON.stringify(extra)).toBe(false)
    }
    expect(dailySummaryQuerySchema.safeParse({ from: '2027-01-01', to: '2028-02-05' }).success).toBe(false)
    expect(dailySummaryQuerySchema.safeParse({ from: '2027-01-01' }).success).toBe(false)
  })

  it('service (bypassing zod): the same limits are a 422, after authorization', async () => {
    const h = await filterHotel()
    const cases: Array<[Partial<RoomCalendarQueryInput> & { from: string, to: string }, string]> = [
      [{ from: '2027-02-01', to: '2027-01-31' }, 'INVALID_RANGE'],
      [{ from: '2027-01-01', to: '2028-02-05' }, 'RANGE_TOO_LONG'],
      [{ from: '2027-02-30', to: '2027-03-01' }, 'INVALID_DATE'],
      [{ ...MARCH, minCapacity: 5, maxCapacity: 4 }, 'INVALID_CAPACITY_RANGE'],
      [{ ...MARCH, minCapacity: -1 }, 'INVALID_CAPACITY_RANGE'],
      [{ ...MARCH, page: 0 }, 'INVALID_PAGE'],
      [{ ...MARCH, pageSize: 201 }, 'INVALID_PAGE'],
      [{ ...MARCH, status: ['BOOKED'] as never }, 'INVALID_STATUS'],
    ]
    for (const [q, code] of cases) await expect(calendar(h.ctx, h.hotel.id, q), code).rejects.toMatchObject({ code, httpStatus: 422 })
    await expect(getDailySummary(h.ctx, h.hotel.id, { from: '2027-01-01', to: '2028-02-05' })).rejects.toMatchObject({ code: 'RANGE_TOO_LONG', httpStatus: 422 })
    // Authorization first: an invalid range on an inaccessible hotel is still the 404.
    const sibling = await makeHotel(db, h.scope)
    await expect(calendar(h.ctx, sibling.id, { from: '2027-02-01', to: '2027-01-31' })).rejects.toMatchObject({ httpStatus: 404 })
    // The 400-day limit itself is accepted.
    expect((await calendar(h.ctx, h.hotel.id, { from: '2027-01-01', to: '2028-02-04', pageSize: 1 })).total).toBe(8)
  })

  it(`TOO_MANY_ROOMS: more than ${MAX_CALENDAR_ROOMS} candidates is a 422 on every page and on the daily summary, never a truncated answer; exactly ${MAX_CALENDAR_ROOMS} is served`, async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx, hotelScope } = await hotelWithManager(scope)
    const repos = hotelRepos(db, hotelScope)
    const type = await makeRoomType(db, scope)
    const [big, small] = await repos.floors.insertMany([{ level: 1, label: 'Big' }, { level: 2, label: 'Small' }])
    // Floor "Big": 5,000 rooms in service since 2025. Floor "Small": ONE room in service from 2028-01-01.
    const rooms = []
    for (let start = 0; start < MAX_CALENDAR_ROOMS; start += 1000) {
      rooms.push(...await repos.rooms.insertMany(Array.from({ length: 1000 }, (_, i) => ({ floorId: big!.id, roomTypeId: type.id, roomNumber: String(10000 + start + i), features: [], notes: null }))))
    }
    for (let start = 0; start < rooms.length; start += 1000) {
      await repos.roomBaseConfigs.insertMany(rooms.slice(start, start + 1000).map(r => ({ roomId: r.id, validFrom: '2025-01-01', validTo: null, physicalBeds: 2, sellableCapacity: 2, origin: 'SEED' })))
    }
    const late = await makeRoom(db, hotelScope, small!.id, type.id, { roomNumber: '20000' })
    await makeRoomBaseConfig(db, hotelScope, late.id, { validFrom: '2028-01-01' })

    const in2027 = { from: '2027-06-01', to: '2027-06-02' }
    const in2028 = { from: '2028-01-01', to: '2028-01-02' }
    // 2027: 5,000 rooms in inventory (the 5,001st is not yet) -> served, exact total.
    const served = await calendar(ctx, hotel.id, { ...in2027, pageSize: 200, page: 25 })
    expect(served).toMatchObject({ total: MAX_CALENDAR_ROOMS })
    expect(served.rooms).toHaveLength(200)
    expect(served.rooms.at(-1)!.roomNumber).toBe('14999')
    expect((await getDailySummary(ctx, hotel.id, in2027)).days[0]!.roomsInInventory).toBe(MAX_CALENDAR_ROOMS)

    const tooMany = { code: 'TOO_MANY_ROOMS', httpStatus: 422 }
    // includeOutOfInventory counts the 5,001st room; so does 2028, where it is in inventory.
    for (const page of [1, 26, 9999]) await expect(calendar(ctx, hotel.id, { ...in2027, includeOutOfInventory: true, page })).rejects.toMatchObject(tooMany)
    for (const page of [1, 26]) await expect(calendar(ctx, hotel.id, { ...in2028, page, pageSize: 1 })).rejects.toMatchObject(tooMany)
    await expect(calendar(ctx, hotel.id, { ...in2028, status: ['NOT_IN_INVENTORY'] })).rejects.toMatchObject(tooMany) // a derived filter would leave 0 rooms: still 422
    await expect(getDailySummary(ctx, hotel.id, in2028)).rejects.toMatchObject(tooMany)
    // A structural filter that narrows the candidates is served.
    expect((await calendar(ctx, hotel.id, { ...in2028, floorId: small!.id })).total).toBe(1)
    expect((await calendar(ctx, hotel.id, { ...in2028, q: '1', pageSize: 1 })).total).toBe(MAX_CALENDAR_ROOMS)
    expect((await getDailySummary(ctx, hotel.id, { ...in2028, floorId: big!.id })).days[0]!.roomsInInventory).toBe(MAX_CALENDAR_ROOMS)
  }, 120_000)

  /**
   * The guard must bound the EXPENSIVE reads: a request with more than MAX_CALENDAR_ROOMS relevant
   * candidates stops after the hotel read, ONE bounded (LIMIT MAX+1) candidate statement and, without
   * includeOutOfInventory, ONE bounded single-table in-inventory id statement — before the settings,
   * base-version, override and block statements. Statements are captured with the drizzle logger;
   * relevance semantics are unchanged (includeOutOfInventory=true counts every structural candidate;
   * false counts only rooms with a base version overlapping the range).
   */
  it(`TOO_MANY_ROOMS is an EARLY guard: > ${MAX_CALENDAR_ROOMS} relevant candidates -> 422 after 2-3 bounded statements, no settings/version/override/block read; relevance semantics preserved`, async () => {
    const { scope } = await makeOrg(db)
    const { hotel, hotelScope } = await hotelWithManager(scope)
    const repos = hotelRepos(db, hotelScope)
    const type = await makeRoomType(db, scope)
    const [big, small, extra] = await repos.floors.insertMany([{ level: 1, label: 'Big' }, { level: 2, label: 'Small' }, { level: 3, label: 'Extra' }])
    const insertRooms = async (floorId: string, count: number, offset: number, validTo: string | null) => {
      for (let start = 0; start < count; start += 1000) {
        const rooms = await repos.rooms.insertMany(Array.from({ length: Math.min(1000, count - start) }, (_, i) => ({ floorId, roomTypeId: type.id, roomNumber: String(offset + start + i), features: [], notes: null })))
        await repos.roomBaseConfigs.insertMany(rooms.map(r => ({ roomId: r.id, validFrom: '2025-01-01', validTo, physicalBeds: 2, sellableCapacity: 2, origin: 'SEED' })))
      }
    }
    // Floor "Big": 5,000 rooms retired on 2026-12-31 (structural candidates, NOT in inventory in 2027).
    // Floor "Small": 100 rooms in inventory all along.  => structural 5,100; in inventory in 2027: 100.
    await insertRooms(big!.id, MAX_CALENDAR_ROOMS, 10000, '2026-12-31')
    await insertRooms(small!.id, 100, 20000, null)

    const logged: Array<{ query: string, params: unknown[] }> = []
    const loggingDb = drizzle(getTestClient(), { schema, logger: { logQuery: (query, params) => logged.push({ query, params }) } }) as Database
    const ctx = makeCtx(scope, { permissions: MANAGER, hotelIds: [hotel.id], db: loggingDb })
    const range = { from: '2027-06-01', to: '2027-06-02' }
    const notRead = (why: string) => { for (const l of logged) for (const table of ['"room_capacity_override"', '"room_operational_block"', '"hotel_setting"']) expect(l.query, `${table} must not be read ${why}`).not.toContain(table) }
    const stmts = () => logged.map(l => l.query.replace(/^select .*? from /, 'from ').slice(0, 60))

    // C: 5,100 structural rooms but 100 overlap the range: served (the default counts only those). The
    // candidate read hit its LIMIT, so the 100 are found by ONE bounded single-table id statement:
    // hotel + candidates + in-inventory ids + candidates by id + settings + 3 range reads = 8.
    logged.length = 0
    const served = await calendar(ctx, hotel.id, range)
    expect(served.total).toBe(100)
    expect(logged, stmts().join('\n')).toHaveLength(8)
    logged.length = 0
    expect((await getDailySummary(ctx, hotel.id, range)).days[0]!.roomsInInventory).toBe(100)
    expect(logged).toHaveLength(8)

    // A: includeOutOfInventory=true counts all 5,100 structural candidates -> 422 after the hotel read and ONE LIMIT-bounded candidate read.
    logged.length = 0
    await expect(calendar(ctx, hotel.id, { ...range, includeOutOfInventory: true })).rejects.toMatchObject({ code: 'TOO_MANY_ROOMS', httpStatus: 422 })
    expect(logged, logged.map(l => l.query).join('\n')).toHaveLength(2)
    expect(logged[1]!.query).toMatch(/from "room"/)
    expect(logged[1]!.query).toMatch(/limit \$\d+/)
    expect(logged[1]!.params).toContain(MAX_CALENDAR_ROOMS + 1)
    notRead('before the guard')

    // B: 5,001 rooms in inventory (4,901 more on floor "Extra") -> 422 EARLY on every endpoint and page: the
    // hotel read, the bounded candidate read and ONE bounded single-table id read (no join of room_base_config).
    await insertRooms(extra!.id, 4901, 30000, null)
    for (const call of [
      () => calendar(ctx, hotel.id, range),
      () => calendar(ctx, hotel.id, { ...range, page: 51, pageSize: 100 }),
      () => calendar(ctx, hotel.id, { ...range, status: ['OUT_OF_SERVICE'] }),
      () => getDailySummary(ctx, hotel.id, range),
    ]) {
      logged.length = 0
      await expect(call()).rejects.toMatchObject({ code: 'TOO_MANY_ROOMS', httpStatus: 422 })
      expect(logged, logged.map(l => l.query).join('\n')).toHaveLength(3)
      expect(logged[1]!.query).toMatch(/limit \$\d+/)
      expect(logged[2]!.query).toMatch(/^select "room_id" from "room_base_config" where .* group by "room_base_config"\."room_id" order by "room_base_config"\."room_id" asc limit \$\d+$/)
      expect(logged[2]!.params).toContain(MAX_CALENDAR_ROOMS + 1)
      notRead('before the guard')
    }
    // Rows read for the limit: exactly MAX + 1, never the whole list.
    const inventoryRepo = new InventoryReadRepository(db, hotelScope)
    expect(await inventoryRepo.listRoomCandidates({ limit: MAX_CALENDAR_ROOMS + 1 })).toHaveLength(MAX_CALENDAR_ROOMS + 1)
    expect(await inventoryRepo.listRoomIdsInInventory(range, { limit: MAX_CALENDAR_ROOMS + 1 })).toHaveLength(MAX_CALENDAR_ROOMS + 1)

    // D: more than 5,000 in the hotel, but a structural filter narrows to <= 5,000 -> served in 6 statements.
    for (const [filter, total] of [[{ floorId: small!.id }, 100], [{ floorId: extra!.id }, 4901], [{ q: '2' }, 100], [{ floorId: big!.id }, 0], [{ floorId: big!.id, includeOutOfInventory: true }, MAX_CALENDAR_ROOMS]] as const) {
      logged.length = 0
      const narrowed = await calendar(ctx, hotel.id, { ...range, ...filter, pageSize: 1 })
      expect(narrowed.total, JSON.stringify(filter)).toBe(total)
      expect(logged, JSON.stringify(filter)).toHaveLength(6)
    }

    // Rare: a filter that STILL leaves more than 5,000 structural rooms in a hotel with more than 5,000 in inventory. Floor
    // "Big" gets 1,500 rooms in service (6,500 structural, 1,500 relevant): served, exact; with 5,001 relevant: 422.
    await insertRooms(big!.id, 1500, 40000, null)
    const bigInventory = await calendar(ctx, hotel.id, { ...range, floorId: big!.id, pageSize: 200, page: 8 })
    expect(bigInventory.total).toBe(1500)
    expect(bigInventory.rooms).toHaveLength(100)
    expect(bigInventory.rooms.every(r => r.roomNumber.startsWith('4'))).toBe(true)
    expect((await getDailySummary(ctx, hotel.id, { ...range, floorId: big!.id })).days[0]!.roomsInInventory).toBe(1500)
    await insertRooms(big!.id, 3501, 50000, null) // 1,500 + 3,501 = 5,001 relevant on "Big"
    logged.length = 0
    await expect(calendar(ctx, hotel.id, { ...range, floorId: big!.id })).rejects.toMatchObject({ code: 'TOO_MANY_ROOMS', httpStatus: 422 })
    notRead('before the guard (paged check)')
    expect(logged.length).toBeLessThanOrEqual(2 + 1 + 2 * 3) // hotel, first candidates, ids, then at most 3 pages of (candidates, ids)
  }, 300_000)
})

describe('6b. response-size guard (CALENDAR_RESPONSE_TOO_LARGE)', () => {
  it('the limit is 2 MiB of real serialized bytes; a body of exactly the limit is served, one byte more is a 422 with the measured size; nothing is truncated', async () => {
    expect(MAX_CALENDAR_RESPONSE_BYTES).toBe(2 * 1024 * 1024)
    const h = await threeRoomHotel()
    const dto = await calendar(h.ctx, h.hotel.id, { from: '2027-05-25', to: '2027-06-10' })
    const bytes = calendarResponseBytes(dto)
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(dto)))
    expect(bytes).toBeLessThan(MAX_CALENDAR_RESPONSE_BYTES)
    expect(() => assertCalendarResponseWithinBudget(dto, bytes)).not.toThrow() // exactly the limit: served
    expect(() => assertCalendarResponseWithinBudget(dto, bytes - 1)).toThrowError(expect.objectContaining({ code: 'CALENDAR_RESPONSE_TOO_LARGE', httpStatus: 422, details: expect.objectContaining({ limitBytes: bytes - 1, bytes }) }))
    // The default limit applies to what getRoomCalendar returns: a normal page is untouched.
    expect(dto.rooms).toHaveLength(3)
    expect(dto.rooms.every(r => r.segments.length > 0)).toBe(true)
  })
})

describe('7. empty hotel', () => {
  it('calendar total 0 / rooms []; daily summary one all-zero row per requested day (no NaN / Infinity)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx } = await hotelWithManager(scope)
    const r = await calendar(ctx, hotel.id, { from: '2027-01-01', to: '2027-12-31', includeOutOfInventory: true })
    expect(r).toEqual({ range: { from: '2027-01-01', to: '2027-12-31' }, page: 1, pageSize: 50, total: 0, meta: { today: '2026-09-25', maintenanceBlocksSales: true }, refs: { periods: {}, blocks: {} }, rooms: [] })
    const s = await getDailySummary(ctx, hotel.id, { from: '2027-02-27', to: '2027-03-02' })
    expect(s.days).toEqual(['2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02'].map(date => ({ date, roomsInInventory: 0, sellableRooms: 0, outOfService: 0, maintenance: 0, operationalBlock: 0, effectiveSellableCapacity: 0, sellableRoomCapacity: 0 })))
    const year = await getDailySummary(ctx, hotel.id, { from: '2027-01-01', to: '2028-02-04' })
    expect(year.days).toHaveLength(400)
    expectJsonSafe(r)
    expectJsonSafe(year)
  })
})

describe('8. authorization', () => {
  it('no room.view -> 403; foreign-org and same-org-inaccessible -> the identical 404; an inactive hotel is readable', async () => {
    const h = await threeRoomHotel()
    const accountant = makeCtx(h.scope, { permissions: ACCOUNTANT, allHotels: true })
    await expect(calendar(accountant, h.hotel.id, MARCH)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 })
    await expect(getDailySummary(accountant, h.hotel.id, MARCH)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 })

    const sibling = await makeHotel(db, h.scope)
    const limited = makeCtx(h.scope, { permissions: READ_ONLY, hotelIds: [sibling.id] })
    const { scope: other } = await makeOrg(db)
    const outsider = makeCtx(other, { permissions: READ_ONLY, allHotels: true })
    const errors: string[] = []
    for (const [ctx, id] of [[limited, h.hotel.id], [outsider, h.hotel.id], [limited, '33333333-3333-3333-3333-333333333333']] as const) {
      for (const call of [() => calendar(ctx, id, MARCH), () => getDailySummary(ctx, id, MARCH)]) {
        const error = await call().then(() => null, (e: { code: string, httpStatus: number, message: string }) => e)
        expect(error).toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404 })
        errors.push(JSON.stringify({ code: error!.code, status: error!.httpStatus, message: error!.message }))
      }
    }
    expect(new Set(errors).size).toBe(1)

    const admin = makeCtx(h.scope, { permissions: MANAGER, allHotels: true })
    await deactivateHotel(admin, h.hotel.id)
    const reader = makeCtx(h.scope, { permissions: READ_ONLY, hotelIds: [h.hotel.id] })
    expect((await calendar(reader, h.hotel.id, { from: '2027-06-01', to: '2027-06-07' })).total).toBe(3)
    expect((await getDailySummary(reader, h.hotel.id, { from: '2027-06-01', to: '2027-06-01' })).days[0]!.roomsInInventory).toBe(3)
  })
})

describe('11. S13: page-scoped refs, meta.today, meta.maintenanceBlocksSales', () => {
  /**
   * Room A (page 1) and room B (page 2) of hotel 1, plus hotel 2 of the same organization with its own
   * period/block. A: period P1 override, an active block, a CANCELLED block, a block outside the range,
   * and a block / override on nights the room is NOT in inventory (loaded, but referenced by no segment).
   * B: period P2 (used only by B) and its own block. P3 overlaps the range but has no override at all.
   */
  async function refsHotels() {
    const { scope } = await makeOrg(db)
    const { hotel, ctx, hotelScope } = await hotelWithManager(scope)
    const floor = await makeFloor(db, hotelScope, { level: 1 })
    const type = await makeRoomType(db, scope)
    const roomA = await makeRoom(db, hotelScope, floor.id, type.id, { roomNumber: '101' })
    const roomB = await makeRoom(db, hotelScope, floor.id, type.id, { roomNumber: '102' })
    // A is in inventory until 2027-06-20 only.
    await makeRoomBaseConfig(db, hotelScope, roomA.id, { validFrom: '2025-01-01', validTo: '2027-06-20' })
    await makeRoomBaseConfig(db, hotelScope, roomB.id)
    const p1 = await makeCapacityPeriod(db, hotelScope, { name: 'P1', kind: 'HAJJ', startDate: '2027-06-01', endDate: '2027-06-10' })
    const p2 = await makeCapacityPeriod(db, hotelScope, { name: 'P2', kind: 'SPECIAL', startDate: '2027-06-11', endDate: '2027-06-15' })
    const p3 = await makeCapacityPeriod(db, hotelScope, { name: 'P3', kind: 'RAMADAN', startDate: '2027-06-16', endDate: '2027-06-18' })
    const pOut = await makeCapacityPeriod(db, hotelScope, { name: 'P-out', kind: 'SPECIAL', startDate: '2027-06-22', endDate: '2027-06-25' })
    await makeRoomCapacityOverride(db, hotelScope, roomA.id, p1.id, { validFrom: '2027-06-01', validTo: '2027-06-10' })
    await makeRoomCapacityOverride(db, hotelScope, roomA.id, pOut.id, { validFrom: '2027-06-22', validTo: '2027-06-25' }) // A is retired then
    await makeRoomCapacityOverride(db, hotelScope, roomB.id, p2.id, { validFrom: '2027-06-11', validTo: '2027-06-15' })
    const aActive = await makeRoomBlock(db, hotelScope, roomA.id, { kind: 'MAINTENANCE', startDate: '2027-06-03', endDate: '2027-06-04', reason: 'A active' })
    const aCancelled = await makeRoomBlock(db, hotelScope, roomA.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-06-05', endDate: '2027-06-06', reason: 'A cancelled' })
    await hotelRepos(db, hotelScope).operationalBlocks.markCancelled(aCancelled.id, new Date(), '00000000-0000-0000-0000-0000000000aa', 'cancelled')
    const aOutside = await makeRoomBlock(db, hotelScope, roomA.id, { kind: 'MAINTENANCE', startDate: '2027-07-10', endDate: '2027-07-12', reason: 'A outside' })
    const aNotInInventory = await makeRoomBlock(db, hotelScope, roomA.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-23', endDate: '2027-06-24', reason: 'A retired nights' })
    const bBlock = await makeRoomBlock(db, hotelScope, roomB.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-12', endDate: '2027-06-12', reason: 'B block' })

    const other = await makeHotel(db, scope, { timezone: 'UTC' })
    const otherScope = trustedHotelScope(scope, other.id)
    const otherFloor = await makeFloor(db, otherScope, { level: 1 })
    const otherRoom = await makeRoom(db, otherScope, otherFloor.id, type.id, { roomNumber: '101' })
    await makeRoomBaseConfig(db, otherScope, otherRoom.id)
    const otherPeriod = await makeCapacityPeriod(db, otherScope, { name: 'Other', startDate: '2027-06-01', endDate: '2027-06-30' })
    await makeRoomCapacityOverride(db, otherScope, otherRoom.id, otherPeriod.id, { validFrom: '2027-06-01', validTo: '2027-06-30' })
    const otherBlock = await makeRoomBlock(db, otherScope, otherRoom.id, { startDate: '2027-06-02', endDate: '2027-06-03' })

    return { scope, hotel, ctx, hotelScope, roomA, roomB, p1, p2, p3, pOut, aActive, aCancelled, aOutside, aNotInInventory, bBlock, other, otherPeriod, otherBlock }
  }
  const JUNE = { from: '2027-06-01', to: '2027-06-30' }

  /** Every period / block id referenced by the page's segments. */
  function referenced(r: RoomCalendarDto) {
    const periods = new Set<string>()
    const blocks = new Set<string>()
    for (const room of r.rooms) {
      for (const s of room.segments) {
        if (s.periodId) periods.add(s.periodId)
        for (const id of s.blockIds) blocks.add(id)
      }
    }
    return { periods, blocks }
  }

  it('refs hold exactly what this page\'s segments reference: not another page\'s, not another hotel\'s, not cancelled, outside-range or unreferenced loaded rows', async () => {
    const h = await refsHotels()
    const page1 = await calendar(h.ctx, h.hotel.id, { ...JUNE, pageSize: 1, page: 1 })
    expect(numbers(page1)).toEqual(['101'])
    expect(page1.refs).toEqual({
      periods: { [h.p1.id]: { name: 'P1', kind: 'HAJJ', startDate: '2027-06-01', endDate: '2027-06-10' } },
      blocks: { [h.aActive.id]: { kind: 'MAINTENANCE', startDate: '2027-06-03', endDate: '2027-06-04', reason: 'A active' } },
    })
    // The block / override on A's out-of-inventory nights were loaded but no segment references them.
    expect(page1.rooms[0]!.segments.at(-1)).toMatchObject({ from: '2027-06-21', to: '2027-06-30', status: 'NOT_IN_INVENTORY', periodId: null, blockIds: [] })

    const page2 = await calendar(h.ctx, h.hotel.id, { ...JUNE, pageSize: 1, page: 2 })
    expect(numbers(page2)).toEqual(['102'])
    expect(page2.refs).toEqual({
      periods: { [h.p2.id]: { name: 'P2', kind: 'SPECIAL', startDate: '2027-06-11', endDate: '2027-06-15' } },
      blocks: { [h.bBlock.id]: { kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-12', endDate: '2027-06-12', reason: 'B block' } },
    })

    const both = await calendar(h.ctx, h.hotel.id, JUNE)
    for (const r of [page1, page2, both]) {
      const used = referenced(r)
      expect(new Set(Object.keys(r.refs.periods))).toEqual(used.periods)
      expect(new Set(Object.keys(r.refs.blocks))).toEqual(used.blocks)
      const serialized = JSON.stringify(r)
      for (const never of [h.p3.id, h.pOut.id, h.aCancelled.id, h.aOutside.id, h.aNotInInventory.id, h.otherPeriod.id, h.otherBlock.id]) expect(serialized).not.toContain(never)
    }
    expect(Object.keys(both.refs.periods).sort()).toEqual([h.p1.id, h.p2.id].sort())
    expect(Object.keys(both.refs.blocks).sort()).toEqual([h.aActive.id, h.bBlock.id].sort())
    // A derived filter that keeps only room B: its page carries only B's refs.
    const onlyB = await calendar(h.ctx, h.hotel.id, { ...JUNE, status: ['OPERATIONAL_BLOCK'] })
    expect(numbers(onlyB)).toEqual(['102'])
    expect(onlyB.refs).toEqual(page2.refs)
  })

  it('withRefs at the repository: refs come only from the scoped override / block statements (other hotel\'s ids never appear); without withRefs the Task 17 shape is unchanged', async () => {
    const h = await refsHotels()
    const repo = new InventoryReadRepository(db, h.hotelScope)
    const loaded = await repo.loadRoomInputs(JUNE, { includeBlocks: true, withRefs: true })
    expect(loaded.rooms.map(r => r.roomNumber)).toEqual(['101', '102'])
    expect([...loaded.refs.periods.keys()].sort()).toEqual([h.p1.id, h.p2.id, h.pOut.id].sort()) // every LOADED override's period (the page-scoping is the service's)
    expect([...loaded.refs.blocks.keys()].sort()).toEqual([h.aActive.id, h.aNotInInventory.id, h.bBlock.id].sort()) // never the cancelled or out-of-range block
    const plain = await repo.loadRoomInputs(JUNE, { includeBlocks: true })
    expect(Array.isArray(plain)).toBe(true)
    expect(plain.map(r => r.roomId)).toEqual(loaded.rooms.map(r => r.roomId))
    expect(plain).toEqual(loaded.rooms)

    // The other hotel's scope with this hotel's room rows passed in: no row of this hotel comes back.
    const otherRepo = new InventoryReadRepository(db, trustedHotelScope(h.scope, h.other.id))
    const candidates = await repo.listRoomCandidates()
    const leaked = await otherRepo.loadRoomInputs(JUNE, { rooms: candidates, includeBlocks: true, includeOutOfInventory: true, withRefs: true })
    expect(leaked.rooms.flatMap(r => [...r.versions, ...r.overrides, ...r.blocks])).toEqual([])
    expect([...leaked.refs.periods.keys(), ...leaked.refs.blocks.keys()]).toEqual([])
  })

  it('meta.today is the hotel-local today (Asia/Riyadh at 21:30Z is already the next day), never UTC; maintenanceBlocksSales mirrors the setting', async () => {
    const { scope } = await makeOrg(db)
    const riyadh = await makeHotel(db, scope, { timezone: 'Asia/Riyadh' })
    const utc = await makeHotel(db, scope, { timezone: 'UTC' })
    const now = new Date('2027-05-01T21:30:00Z')
    const ctx = makeCtx(scope, { permissions: MANAGER, allHotels: true, now: () => now })
    const range = { from: '2027-05-01', to: '2027-05-02' }
    expect((await calendar(ctx, riyadh.id, range)).meta).toEqual({ today: '2027-05-02', maintenanceBlocksSales: true })
    expect((await getDailySummary(ctx, riyadh.id, range)).meta).toEqual({ today: '2027-05-02', maintenanceBlocksSales: true })
    expect((await calendar(ctx, riyadh.id, range)).meta.today).toBe(todayInTimezone('Asia/Riyadh', now))
    expect((await calendar(ctx, utc.id, range)).meta.today).toBe('2027-05-01')
    await updateSettings(ctx, riyadh.id, { 'inventory.maintenanceBlocksSales': false })
    expect((await calendar(ctx, riyadh.id, range)).meta).toEqual({ today: '2027-05-02', maintenanceBlocksSales: false })
    expect((await getDailySummary(ctx, riyadh.id, range)).meta.maintenanceBlocksSales).toBe(false)
    expect((await calendar(ctx, utc.id, range)).meta.maintenanceBlocksSales).toBe(true)
  })

  it('a cancelled block (through the service) disappears from segments and refs', async () => {
    const h = await threeRoomHotel()
    await cancelRoomBlock(h.ctx, h.hotel.id, h.b402.id, { reason: 'Group cancelled' })
    const r = await calendar(h.ctx, h.hotel.id, { from: '2027-06-01', to: '2027-06-07' })
    expect(r.rooms[1]!.segments).toEqual([seg('2027-06-01', '2027-06-07', { physicalBeds: 5, sellableCapacity: 5 })])
    expect(Object.keys(r.refs.blocks)).toEqual([h.b403.id])
  })
})

describe('InventoryReadRepository Task 18 isolation (cross-hotel / cross-organization) and captured SQL', () => {
  async function twoHotels(scope: OrganizationScope) {
    const type = await makeRoomType(db, scope)
    const make = async (n: string) => {
      const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
      const hs = trustedHotelScope(scope, hotel.id)
      const floor = await makeFloor(db, hs, { level: 1 })
      const room = await makeRoom(db, hs, floor.id, type.id, { roomNumber: n })
      await makeRoomBaseConfig(db, hs, room.id)
      const period = await makeCapacityPeriod(db, hs)
      await makeRoomCapacityOverride(db, hs, room.id, period.id)
      const block = await makeRoomBlock(db, hs, room.id)
      return { hotel, hs, floor, room, period, block }
    }
    return { type, h1: await make('101'), h2: await make('201') }
  }

  it('listRoomCandidates: another hotel of the same organization, and another organization, see nothing; foreign floor / type ids leak nothing', async () => {
    const { scope } = await makeOrg(db)
    const { type, h1, h2 } = await twoHotels(scope)
    const repo1 = new InventoryReadRepository(db, h1.hs)
    expect((await repo1.listRoomCandidates()).map(r => r.roomNumber)).toEqual(['101'])
    expect(await repo1.listRoomCandidates({ floorId: h2.floor.id })).toEqual([])
    expect((await repo1.listRoomCandidates({ roomTypeId: type.id })).map(r => r.id)).toEqual([h1.room.id])
    expect(await repo1.listRoomCandidates({ q: '2' })).toEqual([])
    const { scope: other } = await makeOrg(db)
    const foreign = new InventoryReadRepository(db, trustedHotelScope(other, h1.hotel.id))
    expect(await foreign.listRoomCandidates()).toEqual([])
    expect(await foreign.listRoomCandidates({ floorId: h1.floor.id, roomTypeId: type.id })).toEqual([])
    const full = await repo1.listRoomCandidates()
    expect(full).toEqual([{ id: h1.room.id, roomNumber: '101', floorId: h1.floor.id, roomTypeId: type.id, features: [], floor: { id: h1.floor.id, level: 1, label: h1.floor.label }, roomType: { id: type.id, code: type.code, name: type.name } }])
  })

  it('every statement of the calendar read path carries EACH joined table\'s own organization_id (and hotel_id where the table has one), bound to the scope (captured SQL)', async () => {
    const { scope } = await makeOrg(db)
    const { h1 } = await twoHotels(scope)
    const logged: Array<{ query: string, params: unknown[] }> = []
    const loggingDb = drizzle(getTestClient(), { schema, logger: { logQuery: (query, params) => logged.push({ query, params }) } }) as Database
    const repo = new InventoryReadRepository(loggingDb, h1.hs)

    const candidates = await repo.listRoomCandidates({ floorId: h1.floor.id, q: '1', limit: 5001, roomIds: [h1.room.id] })
    expect(await repo.listRoomIdsInInventory({ from: '2027-01-01', to: '2027-12-31' }, { roomIds: [h1.room.id], limit: 5001 })).toEqual([h1.room.id])
    const { rooms, refs } = await repo.loadRoomInputs({ from: '2027-01-01', to: '2027-12-31' }, { rooms: candidates, roomIds: candidates.map(c => c.id), includeBlocks: true, withRefs: true })
    expect(rooms).toHaveLength(1)
    expect(refs.periods.size).toBe(1)
    expect(refs.blocks.size).toBe(1)

    // listRoomCandidates + listRoomIdsInInventory + versions + overrides(+capacity_period) + blocks; NO rooms statement (rows supplied).
    expect(logged).toHaveLength(5)
    const tablesOf = (q: string) => [...q.matchAll(/(?:from|join) "([a-z_]+)"/g)].map(m => m[1]!)
    expect(logged.map(l => tablesOf(l.query).join('+')).sort()).toEqual(['room+floor+room_type', 'room_base_config', 'room_base_config', 'room_capacity_override+capacity_period', 'room_operational_block'].sort())
    const orgOnly = new Set(['room_type'])
    for (const { query, params } of logged) {
      for (const table of tablesOf(query)) {
        const org = new RegExp(`"${table}"\\."organization_id" = \\$(\\d+)`).exec(query)
        expect(org, `${table}: ${query}`).not.toBeNull()
        expect(params[Number(org![1]) - 1]).toBe(scope.organizationId)
        if (orgOnly.has(table)) continue
        const hotel = new RegExp(`"${table}"\\."hotel_id" = \\$(\\d+)`).exec(query)
        expect(hotel, `${table}: ${query}`).not.toBeNull()
        expect(params[Number(hotel![1]) - 1]).toBe(h1.hotel.id)
      }
    }
    // The block statement excludes cancelled blocks.
    expect(logged.find(l => tablesOf(l.query)[0] === 'room_operational_block')!.query).toContain('"room_operational_block"."cancelled_at" is null')
  })
})
