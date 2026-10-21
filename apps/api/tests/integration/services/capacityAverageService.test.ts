import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../../db/schema'
import type { Database } from '../../../db/client'
import { hotelRepos } from '../../../server/repositories'
import { InventoryReadRepository } from '../../../server/repositories/hotel'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { applyOverrides, createCapacityPeriod } from '../../../server/services/capacityPeriodService'
import { getHotelAverages, getOrganizationAverages } from '../../../server/services/capacityAverageService'
import { deactivateHotel, updateSettings } from '../../../server/services/hotelService'
import { cancelRoomBlock, createRoomBlock } from '../../../server/services/operationalBlockService'
import { bulkCreateRooms, changeBaseConfig, createRoom, retireRoom } from '../../../server/services/roomService'
import type { Permission } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { hotelAveragesQuerySchema, organizationAveragesQuerySchema } from '../../../shared/schemas/capacityAverages'
import { todayInTimezone } from '../../../shared/utils/dates'
import { makeFloor, makeHotel, makeOrg, makeRoomType } from '../../support/fixtures'
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
/** Noon UTC on 2026-09-25: the hotel-local today of a UTC hotel is 2026-09-25. */
const CLOCK = () => new Date('2026-09-25T12:00:00Z')

function makeCtx(scope: OrganizationScope, opts: { permissions?: readonly Permission[], allHotels?: boolean, hotelIds?: string[], now?: () => Date } = {}): AuthContext {
  return {
    identity: { userId: '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'caller@test.com', fullName: 'Caller' },
    authz: { permissions: new Set(opts.permissions ?? []), allHotels: opts.allHotels ?? false, hotelIds: new Set(opts.hotelIds ?? []) },
    scope,
    db: db as Database,
    now: opts.now ?? CLOCK,
  }
}

/** Every finite-number / null check the API promises: never NaN, never Infinity, null exactly when the denominator is 0. */
function expectWellFormed(avg: { numerator: number, denominator: number, value: number | null, display: string | null }) {
  expect(Number.isFinite(avg.numerator)).toBe(true)
  expect(Number.isFinite(avg.denominator)).toBe(true)
  if (avg.denominator === 0) {
    expect(avg.value).toBeNull()
    expect(avg.display).toBeNull()
  }
  else {
    expect(Number.isFinite(avg.value)).toBe(true)
    expect(typeof avg.display).toBe('string')
  }
}

/** A JSON round trip leaves the payload unchanged (no NaN/Infinity silently turned into null) and the text has neither token. */
function expectJsonSafe(payload: unknown) {
  const text = JSON.stringify(payload)
  expect(text).not.toMatch(/NaN|Infinity/)
  expect(JSON.parse(text)).toEqual(payload)
}

async function hotelWithManager(scope: OrganizationScope, timezone = 'UTC') {
  const hotel = await makeHotel(db, scope, { timezone })
  const ctx = makeCtx(scope, { permissions: MANAGER, hotelIds: [hotel.id] })
  return { hotel, ctx }
}

/**
 * The requirement example, built only through the real services (nothing typed by a user as an
 * average): 25 Triples (3/3), 40 Quads (4/4), 15 Quints (5/5), in service since 2025-01-01.
 */
async function requirementHotel() {
  const { scope } = await makeOrg(db)
  const { hotel, ctx } = await hotelWithManager(scope)
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const [f1, f2, f3] = [await makeFloor(db, hotelScope, { level: 1 }), await makeFloor(db, hotelScope, { level: 2 }), await makeFloor(db, hotelScope, { level: 3 })]
  const triple = await makeRoomType(db, scope, { defaultPhysicalBeds: 3, defaultSellableCapacity: 3 })
  const quad = await makeRoomType(db, scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  const quint = await makeRoomType(db, scope, { defaultPhysicalBeds: 5, defaultSellableCapacity: 5 })
  const triples = await bulkCreateRooms(ctx, hotel.id, { floorId: f1!.id, roomTypeId: triple.id, inServiceFrom: '2025-01-01', range: { from: 101, to: 125 } })
  const quads = await bulkCreateRooms(ctx, hotel.id, { floorId: f2!.id, roomTypeId: quad.id, inServiceFrom: '2025-01-01', range: { from: 201, to: 240 } })
  const quints = await bulkCreateRooms(ctx, hotel.id, { floorId: f3!.id, roomTypeId: quint.id, inServiceFrom: '2025-01-01', range: { from: 301, to: 315 } })
  return { scope, hotel, ctx, floors: { f1: f1!, f2: f2!, f3: f3! }, types: { triple, quad, quint }, triples, quads, quints }
}

/** Hajj 2027 (`2027-05-01…07-31`): the 25 Triples and the first 5 Quads uplifted to 6/6 through the real period/override services. */
async function applyHajj(ctx: AuthContext, hotelId: string, roomIds: string[]) {
  const period = await createCapacityPeriod(ctx, hotelId, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
  await applyOverrides(ctx, hotelId, period.id, { selector: { roomIds }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, onConflict: 'FAIL' })
  return period
}

describe('1. the requirement example end to end (80 rooms -> 310 / 80 = 3.875 -> "3.88")', () => {
  it('base and date-effective averages come from real room/base-config rows', async () => {
    const { hotel, ctx } = await requirementHotel()

    const r = await getHotelAverages(ctx, hotel.id, { date: '2026-10-01' })

    expect(r.base).toEqual({ numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' })
    expect(r.dateEffective).toEqual({ numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' })
    expect(r.date).toBe('2026-10-01')
    expect(r.range).toBeNull()
    expect(r.availableStay).toBeNull()
    expectJsonSafe(r)
  })

  it('without `date` the hotel-local today is used (injected clock)', async () => {
    const { hotel, ctx } = await requirementHotel()
    const r = await getHotelAverages(ctx, hotel.id, {})
    expect(r.date).toBe('2026-09-25')
    expect(r.base).toMatchObject({ numerator: 310, denominator: 80, display: '3.88' })
  })

  it('S12 (hotel endpoint): without `date` a non-UTC hotel uses ITS local today — Asia/Riyadh at 21:30Z is already the next day', async () => {
    const { scope, hotels: [riyadh] } = await orgWithHotels([{ timezone: 'Asia/Riyadh', rooms: [{ cap: 4 }, { cap: 6, from: '2027-05-02' }] }])
    const now = new Date('2027-05-01T21:30:00Z')
    const r = await getHotelAverages(makeCtx(scope, { permissions: READ_ONLY, allHotels: true, now: () => now }), riyadh!.id, {})
    expect(r.date).toBe('2027-05-02')
    expect(r.date).toBe(todayInTimezone('Asia/Riyadh', now))
    // The room commissioned on 2027-05-02 counts: the evaluation really used the Riyadh date (UTC would give 4 / 1).
    expect(r.base).toMatchObject({ numerator: 10, denominator: 2 })
  })
})

describe('2. Hajj: 30 rooms overridden to 6 for 2027-05-01…07-31', () => {
  it('dateEffective on 2027-06-01 = (310 + 75 + 10) / 80 = 4.9375 -> "4.94"; base stays 3.875; back to 3.875 on 2027-08-01', async () => {
    const { hotel, ctx, triples, quads } = await requirementHotel()
    await applyHajj(ctx, hotel.id, [...triples.map(r => r.id), ...quads.slice(0, 5).map(r => r.id)])

    const during = await getHotelAverages(ctx, hotel.id, { date: '2027-06-01' })
    expect(during.dateEffective).toEqual({ numerator: 395, denominator: 80, value: 4.9375, display: '4.94', basis: 'ROOMS' })
    expect(during.base).toEqual({ numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' })

    const before = await getHotelAverages(ctx, hotel.id, { date: '2027-04-30' })
    expect(before.dateEffective).toMatchObject({ numerator: 310, denominator: 80, display: '3.88' })
    const firstNight = await getHotelAverages(ctx, hotel.id, { date: '2027-05-01' })
    expect(firstNight.dateEffective).toMatchObject({ numerator: 395, display: '4.94' })
    const lastNight = await getHotelAverages(ctx, hotel.id, { date: '2027-07-31' })
    expect(lastNight.dateEffective).toMatchObject({ numerator: 395, display: '4.94' })

    const after = await getHotelAverages(ctx, hotel.id, { date: '2027-08-01' })
    expect(after.dateEffective).toEqual({ numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' })
    expect(after.base).toEqual(after.dateEffective)
  })
})

describe('3. range average across the period boundary (2027-07-30…2027-08-02)', () => {
  it('is weighted by room-nights and equals the hand-computed value', async () => {
    const { hotel, ctx, triples, quads } = await requirementHotel()
    await applyHajj(ctx, hotel.id, [...triples.map(r => r.id), ...quads.slice(0, 5).map(r => r.id)])

    const r = await getHotelAverages(ctx, hotel.id, { date: '2027-07-30', from: '2027-07-30', to: '2027-08-02' })
    // 07-30, 07-31: 80 rooms x Hajj (395 each night); 08-01, 08-02: 80 rooms x base (310 each night).
    expect(r.range).toEqual({ from: '2027-07-30', to: '2027-08-02', numerator: 395 * 2 + 310 * 2, denominator: 80 * 4, value: 1410 / 320, display: '4.41', basis: 'ROOM_NIGHTS' })
  })

  it('is NOT the mean of the daily averages when the room count changes inside the range', async () => {
    const { hotel, ctx, triples, quads, floors, types } = await requirementHotel()
    await applyHajj(ctx, hotel.id, [...triples.map(r => r.id), ...quads.slice(0, 5).map(r => r.id)])
    // 20 new Quints (5/5) are commissioned on 2027-08-01: 100 rooms on the last two nights.
    await bulkCreateRooms(ctx, hotel.id, { floorId: floors.f3.id, roomTypeId: types.quint.id, inServiceFrom: '2027-08-01', range: { from: 321, to: 340 } })

    const r = await getHotelAverages(ctx, hotel.id, { from: '2027-07-30', to: '2027-08-02' })
    // Hand computation: (395 + 395 + 410 + 410) / (80 + 80 + 100 + 100) = 1610 / 360 = 4.4722… -> "4.47".
    expect(r.range).toMatchObject({ numerator: 1610, denominator: 360, display: '4.47', basis: 'ROOM_NIGHTS' })
    expect(r.range!.value).toBeCloseTo(1610 / 360, 12)
    // The mean of the four daily averages would be (4.9375 + 4.9375 + 4.1 + 4.1) / 4 = 4.51875 -> "4.52".
    const meanOfDaily = (395 / 80 + 395 / 80 + 410 / 100 + 410 / 100) / 4
    expect(r.range!.value).not.toBeCloseTo(meanOfDaily, 2)
  })
})

describe('4. history stays correct (retired / commissioned rooms)', () => {
  it('a room retired effective 2027-01-01 counts on 2026-06-01 but not on 2027-01-01; a room commissioned 2027-03-01 is absent before that date', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx } = await hotelWithManager(scope)
    const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
    const type = await makeRoomType(db, scope)
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: '101', inServiceFrom: '2025-01-01', physicalBeds: 4, sellableCapacity: 4, features: [] })
    const retiring = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: '102', inServiceFrom: '2025-01-01', physicalBeds: 5, sellableCapacity: 5, features: [] })
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: '103', inServiceFrom: '2027-03-01', physicalBeds: 6, sellableCapacity: 6, features: [] })
    await retireRoom(ctx, hotel.id, retiring.id, { effectiveFrom: '2027-01-01' })

    const avg = async (date: string) => (await getHotelAverages(ctx, hotel.id, { date })).base
    expect(await avg('2026-06-01')).toMatchObject({ numerator: 9, denominator: 2, display: '4.50' })
    expect(await avg('2026-12-31')).toMatchObject({ numerator: 9, denominator: 2 })
    expect(await avg('2027-01-01')).toMatchObject({ numerator: 4, denominator: 1, display: '4.00' })
    expect(await avg('2027-02-28')).toMatchObject({ numerator: 4, denominator: 1 })
    expect(await avg('2027-03-01')).toMatchObject({ numerator: 10, denominator: 2, display: '5.00' })

    // Range across the retirement: room 102 contributes exactly its 2 in-inventory nights.
    const r = await getHotelAverages(ctx, hotel.id, { from: '2026-12-30', to: '2027-01-02' })
    expect(r.range).toMatchObject({ numerator: 4 * 4 + 5 * 2, denominator: 4 + 2, display: '4.33' })
  })

  it('a base-capacity change is dated: the old capacity before it, the new one from it', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx } = await hotelWithManager(scope)
    const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
    const type = await makeRoomType(db, scope)
    const room = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: '101', inServiceFrom: '2025-01-01', physicalBeds: 4, sellableCapacity: 4, features: [] })
    await changeBaseConfig(ctx, hotel.id, room.id, { effectiveFrom: '2027-01-01', physicalBeds: 5, sellableCapacity: 5 })

    expect((await getHotelAverages(ctx, hotel.id, { date: '2026-12-31' })).base).toMatchObject({ numerator: 4, denominator: 1 })
    expect((await getHotelAverages(ctx, hotel.id, { date: '2027-01-01' })).base).toMatchObject({ numerator: 5, denominator: 1 })
  })
})

/**
 * R1 4/4 OUT_OF_SERVICE 04-30; R2 4/4 MAINTENANCE 05-01…05-02; R3 5/5 OPERATIONAL_BLOCK 05-10…05-12
 * (outside the stay); R4 4/4 with a Hajj 6/6 override from 05-01; R5 3/3 OPERATIONAL_BLOCK 05-02.
 * Stay [2027-04-29, 2027-05-04) = nights 04-29…05-03.
 */
async function blockHotel() {
  const { scope } = await makeOrg(db)
  const { hotel, ctx } = await hotelWithManager(scope)
  const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
  const type = await makeRoomType(db, scope)
  const room = (n: string, cap: number) => createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: n, inServiceFrom: '2025-01-01', physicalBeds: cap, sellableCapacity: cap, features: [] })
  const r1 = await room('101', 4)
  const r2 = await room('102', 4)
  const r3 = await room('103', 5)
  const r4 = await room('104', 4)
  const r5 = await room('105', 3)
  await applyHajj(ctx, hotel.id, [r4.id])
  await createRoomBlock(ctx, hotel.id, r1.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-04-30', endDate: '2027-04-30', reason: 'Broken AC' })
  await createRoomBlock(ctx, hotel.id, r2.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-02', reason: 'Paint' })
  await createRoomBlock(ctx, hotel.id, r3.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-05-10', endDate: '2027-05-12', reason: 'Staff' })
  await createRoomBlock(ctx, hotel.id, r5.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2027-05-02', endDate: '2027-05-02', reason: 'VIP hold' })
  return { scope, hotel, ctx, r1, r2, r3, r4, r5 }
}

describe('5. operational blocks: structural averages ignore them; availableStay honors them', () => {
  it('base/dateEffective on a blocked night are exactly what they would be without blocks', async () => {
    const { hotel, ctx } = await blockHotel()
    const r = await getHotelAverages(ctx, hotel.id, { date: '2027-05-02' })
    expect(r.base).toMatchObject({ numerator: 4 + 4 + 5 + 4 + 3, denominator: 5, display: '4.00' })
    expect(r.dateEffective).toMatchObject({ numerator: 4 + 4 + 5 + 6 + 3, denominator: 5, display: '4.40' })
    const range = await getHotelAverages(ctx, hotel.id, { from: '2027-04-29', to: '2027-05-03' })
    // 5 rooms x 5 nights; R4 is 4 for 04-29/04-30 and 6 for 05-01…05-03 — blocks change nothing.
    expect(range.range).toMatchObject({ numerator: (4 + 4 + 5 + 3) * 5 + 4 * 2 + 6 * 3, denominator: 25 })

    // The same, with a stay so the blocks ARE loaded into the very rooms base/dateEffective/range read.
    const withBlocksLoaded = await getHotelAverages(ctx, hotel.id, { date: '2027-05-02', from: '2027-04-29', to: '2027-05-03', stayCheckIn: '2027-04-29', stayCheckOut: '2027-05-04' })
    expect(withBlocksLoaded.availableStay).toMatchObject({ eligibleRoomCount: 2 }) // the blocks really were loaded
    expect(withBlocksLoaded.base).toEqual(r.base)
    expect(withBlocksLoaded.dateEffective).toEqual(r.dateEffective)
    expect(withBlocksLoaded.range).toEqual(range.range)
  })

  it('availableStay excludes rooms blocked on any night, uses each room\'s minimum capacity; maintenanceBlocksSales=true (default)', async () => {
    const { hotel, ctx, r3, r4 } = await blockHotel()
    const r = await getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-04-29', stayCheckOut: '2027-05-04', includeRoomIds: true })
    // Eligible: R3 (5) and R4 (min(4,4,6,6,6) = 4). R1 OUT_OF_SERVICE, R2 MAINTENANCE, R5 OPERATIONAL_BLOCK -> excluded.
    expect(r.availableStay).toMatchObject({ checkIn: '2027-04-29', checkOut: '2027-05-04', numerator: 9, denominator: 2, value: 4.5, display: '4.50', basis: 'ROOMS', eligibleRoomCount: 2 })
    expect([...r.availableStay!.eligibleRoomIds!].sort()).toEqual([r3.id, r4.id].sort())
  })

  it('maintenanceBlocksSales=false: MAINTENANCE no longer excludes; OUT_OF_SERVICE and OPERATIONAL_BLOCK still do', async () => {
    const { hotel, ctx, r2, r3, r4 } = await blockHotel()
    await updateSettings(ctx, hotel.id, { 'inventory.maintenanceBlocksSales': false })
    const r = await getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-04-29', stayCheckOut: '2027-05-04', includeRoomIds: true })
    expect(r.availableStay).toMatchObject({ numerator: 4 + 5 + 4, denominator: 3, display: '4.33', eligibleRoomCount: 3 })
    expect([...r.availableStay!.eligibleRoomIds!].sort()).toEqual([r2.id, r3.id, r4.id].sort())
  })

  it('a cancelled block no longer excludes the room; same-day turnover: checkOut on the first blocked night is fine', async () => {
    const { hotel, ctx, r1 } = await blockHotel()
    // Stay [04-28, 04-30) = nights 04-28, 04-29: R1's 04-30 OUT_OF_SERVICE night is not part of it.
    const turnover = await getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-04-28', stayCheckOut: '2027-04-30', includeRoomIds: true })
    expect(turnover.availableStay!.eligibleRoomIds).toContain(r1.id)
    expect(turnover.availableStay).toMatchObject({ eligibleRoomCount: 5, numerator: 4 + 4 + 5 + 4 + 3 })

    const blocks = await db.query.roomOperationalBlock.findMany({ where: (b, { eq }) => eq(b.roomId, r1.id) })
    await cancelRoomBlock(ctx, hotel.id, blocks[0]!.id, { reason: 'Fixed early' })
    const r = await getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-04-29', stayCheckOut: '2027-05-04', includeRoomIds: true })
    expect(r.availableStay!.eligibleRoomIds).toContain(r1.id)
  })

  it('eligibleRoomIds is only present with includeRoomIds=true; eligibleRoomCount is always present', async () => {
    const { hotel, ctx } = await blockHotel()
    const r = await getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-04-29', stayCheckOut: '2027-05-04' })
    expect(r.availableStay).toMatchObject({ eligibleRoomCount: 2 })
    expect(r.availableStay).not.toHaveProperty('eligibleRoomIds')
  })
})

describe('6. empty and zero states -> value null, display null (never 0 / NaN / Infinity)', () => {
  it('a hotel with no rooms', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx } = await hotelWithManager(scope)
    const r = await getHotelAverages(ctx, hotel.id, { date: '2027-06-01', from: '2027-06-01', to: '2027-06-30', stayCheckIn: '2027-06-01', stayCheckOut: '2027-06-05', includeRoomIds: true })
    for (const avg of [r.base, r.dateEffective, r.range!, r.availableStay!]) {
      expect(avg).toMatchObject({ numerator: 0, denominator: 0, value: null, display: null })
      expectWellFormed(avg)
    }
    expect(r.availableStay).toMatchObject({ eligibleRoomCount: 0, eligibleRoomIds: [] })
    expectJsonSafe(r)
  })

  it('a date / range before any room exists', async () => {
    const { hotel, ctx } = await requirementHotel()
    const r = await getHotelAverages(ctx, hotel.id, { date: '2020-01-01', from: '2020-01-01', to: '2020-12-31' })
    expect(r.base).toEqual({ numerator: 0, denominator: 0, value: null, display: null, basis: 'ROOMS' })
    expect(r.dateEffective).toEqual({ numerator: 0, denominator: 0, value: null, display: null, basis: 'ROOMS' })
    expect(r.range).toMatchObject({ numerator: 0, denominator: 0, value: null, display: null, basis: 'ROOM_NIGHTS' })
    expectJsonSafe(r)
  })

  it('all rooms out of service for the stay', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx } = await hotelWithManager(scope)
    const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
    const type = await makeRoomType(db, scope)
    for (const n of ['101', '102']) {
      const room = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: n, inServiceFrom: '2025-01-01', features: [] })
      await createRoomBlock(ctx, hotel.id, room.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-06-01', endDate: '2027-06-10', reason: 'Renovation' })
    }
    const r = await getHotelAverages(ctx, hotel.id, { date: '2027-06-02', stayCheckIn: '2027-06-02', stayCheckOut: '2027-06-04', includeRoomIds: true })
    expect(r.availableStay).toMatchObject({ numerator: 0, denominator: 0, value: null, display: null, eligibleRoomCount: 0, eligibleRoomIds: [] })
    // The structural averages still count both rooms (blocks never change capacity).
    expect(r.dateEffective).toMatchObject({ numerator: 8, denominator: 2, display: '4.00' })
    expectJsonSafe(r)
  })

  it('organization averages with no accessible active hotel', async () => {
    const { scope } = await makeOrg(db)
    const r = await getOrganizationAverages(makeCtx(scope, { permissions: READ_ONLY, allHotels: true }), {})
    expect(r).toEqual({
      date: null,
      base: { numerator: 0, denominator: 0, value: null, display: null, basis: 'ROOMS' },
      dateEffective: { numerator: 0, denominator: 0, value: null, display: null, basis: 'ROOMS' },
      perHotel: [],
    })
    expectJsonSafe(r)
  })
})

/** One hotel per (timezone, rooms) spec, all through the real room service. */
async function orgWithHotels(specs: Array<{ timezone?: string, rooms: Array<{ cap: number, from?: string }> }>) {
  const { scope } = await makeOrg(db)
  const admin = makeCtx(scope, { permissions: MANAGER, allHotels: true })
  const type = await makeRoomType(db, scope)
  const hotels = []
  for (const spec of specs) {
    const hotel = await makeHotel(db, scope, { timezone: spec.timezone ?? 'UTC' })
    const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
    let n = 100
    for (const room of spec.rooms) {
      await createRoom(admin, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: String(++n), inServiceFrom: room.from ?? '2025-01-01', physicalBeds: Math.max(room.cap, 1), sellableCapacity: room.cap, features: [] })
    }
    hotels.push(hotel)
  }
  return { scope, admin, hotels }
}

describe('7. organization averages', () => {
  it('two hotels of different sizes -> weighted sums (sum of numerators / sum of denominators), not the mean of the two averages', async () => {
    const { scope, hotels: [a, b] } = await orgWithHotels([
      { rooms: [{ cap: 3 }] }, // 3 / 1 = 3.00
      { rooms: [{ cap: 5 }, { cap: 5 }, { cap: 5 }, { cap: 5 }] }, // 20 / 4 = 5.00
    ])
    const ctx = makeCtx(scope, { permissions: READ_ONLY, allHotels: true })
    const hotelA = await getHotelAverages(ctx, a!.id, { date: '2026-10-01' })
    const hotelB = await getHotelAverages(ctx, b!.id, { date: '2026-10-01' })

    const org = await getOrganizationAverages(ctx, { date: '2026-10-01' })
    expect(org.base.numerator).toBe(hotelA.base.numerator + hotelB.base.numerator)
    expect(org.base.denominator).toBe(hotelA.base.denominator + hotelB.base.denominator)
    expect(org.base).toEqual({ numerator: 23, denominator: 5, value: 4.6, display: '4.60', basis: 'ROOMS' })
    expect(org.dateEffective).toEqual(org.base)
    const meanOfAverages = (hotelA.base.value! + hotelB.base.value!) / 2
    expect(meanOfAverages).toBe(4)
    expect(org.base.value).not.toBe(meanOfAverages)

    expect(org.date).toBe('2026-10-01')
    expect(org.perHotel).toHaveLength(2)
    const byId = new Map(org.perHotel.map(h => [h.hotelId, h]))
    expect(byId.get(a!.id)).toEqual({ hotelId: a!.id, code: a!.code, name: a!.name, date: '2026-10-01', base: hotelA.base, dateEffective: hotelA.dateEffective })
    expect(byId.get(b!.id)).toEqual({ hotelId: b!.id, code: b!.code, name: b!.name, date: '2026-10-01', base: hotelB.base, dateEffective: hotelB.dateEffective })
    expectJsonSafe(org)
  })

  it('S12: without `date` each hotel is evaluated on its own hotel-local today (Asia/Riyadh vs UTC at 21:30Z); top-level date is null', async () => {
    const { scope, hotels: [riyadh, utc] } = await orgWithHotels([
      // In Riyadh it is already 2027-05-02 00:30: the room commissioned on 05-02 counts there.
      { timezone: 'Asia/Riyadh', rooms: [{ cap: 4 }, { cap: 6, from: '2027-05-02' }] },
      { timezone: 'UTC', rooms: [{ cap: 3 }, { cap: 5, from: '2027-05-02' }] },
    ])
    const now = new Date('2027-05-01T21:30:00Z')
    const ctx = makeCtx(scope, { permissions: READ_ONLY, allHotels: true, now: () => now })

    const org = await getOrganizationAverages(ctx, {})
    expect(org.date).toBeNull()
    const byId = new Map(org.perHotel.map(h => [h.hotelId, h]))
    expect(byId.get(riyadh!.id)!.date).toBe('2027-05-02')
    expect(byId.get(riyadh!.id)!.date).toBe(todayInTimezone('Asia/Riyadh', now))
    expect(byId.get(utc!.id)!.date).toBe('2027-05-01')
    expect(byId.get(utc!.id)!.date).toBe(todayInTimezone('UTC', now))
    // Riyadh on 05-02: (4 + 6) / 2; UTC on 05-01: 3 / 1 (its 05-02 room is not in inventory yet).
    expect(byId.get(riyadh!.id)!.base).toMatchObject({ numerator: 10, denominator: 2 })
    expect(byId.get(utc!.id)!.base).toMatchObject({ numerator: 3, denominator: 1 })
    expect(org.base).toMatchObject({ numerator: 13, denominator: 3, display: '4.33' })
    for (const item of org.perHotel) {
      expect(Object.keys(item).sort()).toEqual(['base', 'code', 'date', 'dateEffective', 'hotelId', 'name'])
    }

    // An explicit date applies to every hotel and is echoed at the top level.
    const explicit = await getOrganizationAverages(ctx, { date: '2027-06-01' })
    expect(explicit.date).toBe('2027-06-01')
    expect(explicit.perHotel.map(h => h.date)).toEqual(['2027-06-01', '2027-06-01'])
    expect(explicit.base).toMatchObject({ numerator: 4 + 6 + 3 + 5, denominator: 4 })
  })

  it('a user with access to one of two hotels sees only theirs; inactive hotels are excluded from the default set', async () => {
    const { scope, admin, hotels: [a, b, c] } = await orgWithHotels([{ rooms: [{ cap: 3 }] }, { rooms: [{ cap: 5 }] }, { rooms: [{ cap: 6 }] }])
    const limited = makeCtx(scope, { permissions: READ_ONLY, hotelIds: [a!.id] })
    const onlyA = await getOrganizationAverages(limited, { date: '2026-10-01' })
    expect(onlyA.perHotel.map(h => h.hotelId)).toEqual([a!.id])
    expect(onlyA.base).toMatchObject({ numerator: 3, denominator: 1 })

    await deactivateHotel(admin, c!.id)
    const all = makeCtx(scope, { permissions: READ_ONLY, allHotels: true })
    const active = await getOrganizationAverages(all, { date: '2026-10-01' })
    expect(active.perHotel.map(h => h.hotelId).sort()).toEqual([a!.id, b!.id].sort())
    expect(active.base).toMatchObject({ numerator: 8, denominator: 2 })

    // An inactive hotel named explicitly is still readable (read endpoints allow inactive hotels).
    const explicit = await getOrganizationAverages(all, { date: '2026-10-01', hotelIds: [c!.id] })
    expect(explicit.perHotel.map(h => h.hotelId)).toEqual([c!.id])
    expect(explicit.base).toMatchObject({ numerator: 6, denominator: 1 })
  })

  it('hotelIds with a foreign-org, an inaccessible or a nonexistent hotel -> the identical 404 HOTEL_NOT_FOUND', async () => {
    const { scope, hotels: [a, b] } = await orgWithHotels([{ rooms: [{ cap: 3 }] }, { rooms: [{ cap: 5 }] }])
    const { scope: other } = await makeOrg(db)
    const foreign = await makeHotel(db, other)
    const limited = makeCtx(scope, { permissions: READ_ONLY, hotelIds: [a!.id] })

    for (const bad of [foreign.id, b!.id, '33333333-3333-3333-3333-333333333333']) {
      await expect(getOrganizationAverages(limited, { hotelIds: [a!.id, bad] })).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404, message: 'HOTEL_NOT_FOUND' })
    }
    const ok = await getOrganizationAverages(limited, { date: '2026-10-01', hotelIds: [a!.id] })
    expect(ok.perHotel.map(h => h.hotelId)).toEqual([a!.id])
  })

  it('no room.view -> 403 FORBIDDEN (organization and hotel endpoints)', async () => {
    const { scope, hotels: [a] } = await orgWithHotels([{ rooms: [{ cap: 3 }] }])
    const accountant = makeCtx(scope, { permissions: ACCOUNTANT, allHotels: true })
    await expect(getOrganizationAverages(accountant, {})).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 })
    await expect(getHotelAverages(accountant, a!.id, {})).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 })
  })
})

describe('hotel endpoint authorization', () => {
  it('foreign-org, inaccessible and nonexistent hotels -> the identical 404; an inactive hotel is readable', async () => {
    const { scope, admin, hotels: [a, b] } = await orgWithHotels([{ rooms: [{ cap: 3 }] }, { rooms: [{ cap: 5 }] }])
    const { scope: other } = await makeOrg(db)
    const foreign = await makeHotel(db, other)
    const limited = makeCtx(scope, { permissions: READ_ONLY, hotelIds: [a!.id] })
    for (const bad of [foreign.id, b!.id, '33333333-3333-3333-3333-333333333333']) {
      await expect(getHotelAverages(limited, bad, {})).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404 })
    }
    // Authorization runs before validation: an invalid range on an inaccessible hotel is still a 404.
    await expect(getHotelAverages(limited, b!.id, { from: '2027-02-01', to: '2027-01-01' })).rejects.toMatchObject({ httpStatus: 404 })

    await deactivateHotel(admin, a!.id)
    expect((await getHotelAverages(limited, a!.id, { date: '2026-10-01' })).base).toMatchObject({ numerator: 3, denominator: 1 })
  })
})

describe('8. limits -> 422', () => {
  it('schema: from > to, range > 400 days, stay > 90 nights, 2027-02-30, half a pair, checkOut <= checkIn, unknown keys', () => {
    const ok = (q: Record<string, unknown>) => expect(hotelAveragesQuerySchema.safeParse(q).success).toBe(true)
    const bad = (q: Record<string, unknown>) => expect(hotelAveragesQuerySchema.safeParse(q).success).toBe(false)
    ok({})
    ok({ from: '2027-01-01', to: '2028-02-04' }) // 400 days
    ok({ stayCheckIn: '2027-01-01', stayCheckOut: '2027-04-01' }) // 90 nights
    bad({ from: '2027-02-01', to: '2027-01-31' })
    bad({ from: '2027-01-01', to: '2028-02-05' }) // 401 days
    bad({ stayCheckIn: '2027-01-01', stayCheckOut: '2027-04-02' }) // 91 nights
    bad({ date: '2027-02-30' })
    bad({ from: '2027-02-30', to: '2027-03-01' })
    bad({ stayCheckIn: '2027-02-30', stayCheckOut: '2027-03-02' })
    bad({ from: '2027-01-01' })
    bad({ stayCheckOut: '2027-01-02' })
    bad({ stayCheckIn: '2027-01-01', stayCheckOut: '2027-01-01' })
    bad({ date: '2027-06-01T00:00:00Z' })
    bad({ includeRoomIds: 'yes' })
    bad({ hotelId: '11111111-1111-1111-1111-111111111111' })
    expect(hotelAveragesQuerySchema.parse({ includeRoomIds: 'true' }).includeRoomIds).toBe(true)

    expect(organizationAveragesQuerySchema.parse({ hotelIds: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).hotelIds).toHaveLength(2)
    expect(organizationAveragesQuerySchema.parse({ hotelIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }).hotelIds).toHaveLength(1)
    expect(organizationAveragesQuerySchema.safeParse({ hotelIds: 'not-a-uuid' }).success).toBe(false)
    expect(organizationAveragesQuerySchema.safeParse({ hotelIds: '' }).success).toBe(false)
    expect(organizationAveragesQuerySchema.safeParse({ date: '2027-02-30' }).success).toBe(false)
    expect(organizationAveragesQuerySchema.safeParse({ from: '2027-01-01' }).success).toBe(false)

    // hotelIds: at most 200 (counted as received — 201 copies of one id do not slip through by deduplication).
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(organizationAveragesQuerySchema.parse({ hotelIds: ids(200).join(',') }).hotelIds).toHaveLength(200)
    expect(organizationAveragesQuerySchema.safeParse({ hotelIds: ids(201).join(',') }).success).toBe(false)
    expect(organizationAveragesQuerySchema.safeParse({ hotelIds: ids(201) }).success).toBe(false)
    expect(organizationAveragesQuerySchema.safeParse({ hotelIds: Array.from({ length: 201 }, () => ids(1)[0]) }).success).toBe(false)
  })

  it('service (bypassing zod): the same limits are a 422, after authorization', async () => {
    const { hotel, ctx } = await requirementHotel()
    await expect(getHotelAverages(ctx, hotel.id, { from: '2027-02-01', to: '2027-01-31' })).rejects.toMatchObject({ code: 'INVALID_RANGE', httpStatus: 422 })
    await expect(getHotelAverages(ctx, hotel.id, { from: '2027-01-01', to: '2028-02-05' })).rejects.toMatchObject({ code: 'RANGE_TOO_LONG', httpStatus: 422 })
    await expect(getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-01-01', stayCheckOut: '2027-04-02' })).rejects.toMatchObject({ code: 'STAY_TOO_LONG', httpStatus: 422 })
    await expect(getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-01-02', stayCheckOut: '2027-01-02' })).rejects.toMatchObject({ code: 'INVALID_STAY', httpStatus: 422 })
    await expect(getHotelAverages(ctx, hotel.id, { date: '2027-02-30' })).rejects.toMatchObject({ code: 'INVALID_DATE', httpStatus: 422 })
    await expect(getHotelAverages(ctx, hotel.id, { from: '2027-02-30', to: '2027-03-01' })).rejects.toMatchObject({ code: 'INVALID_DATE', httpStatus: 422 })
    await expect(getOrganizationAverages(ctx, { date: '2027-02-30' })).rejects.toMatchObject({ code: 'INVALID_DATE', httpStatus: 422 })
    // The boundaries themselves are accepted.
    const atLimits = await getHotelAverages(ctx, hotel.id, { from: '2027-01-01', to: '2028-02-04', stayCheckIn: '2027-01-01', stayCheckOut: '2027-04-01' })
    expect(atLimits.range).toMatchObject({ numerator: 310 * 400, denominator: 80 * 400 })
    expect(atLimits.availableStay).toMatchObject({ numerator: 310, denominator: 80, eligibleRoomCount: 80 })
  })
})

describe('eligibleRoomIds cap', () => {
  it('2,001 eligible rooms: eligibleRoomCount is exact (2001), eligibleRoomIds holds the first 2,000 (the cap is visible as ids < count)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, ctx } = await hotelWithManager(scope)
    const repos = hotelRepos(db, trustedHotelScope(scope, hotel.id))
    const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
    const type = await makeRoomType(db, scope)
    const rooms = []
    for (let start = 0; start < 2001; start += 1000) {
      rooms.push(...await repos.rooms.insertMany(Array.from({ length: Math.min(1000, 2001 - start) }, (_, i) => ({ floorId: floor.id, roomTypeId: type.id, roomNumber: String(10000 + start + i), features: [], notes: null }))))
    }
    for (let start = 0; start < rooms.length; start += 1000) {
      await repos.roomBaseConfigs.insertMany(rooms.slice(start, start + 1000).map(r => ({ roomId: r.id, validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4, origin: 'SEED' })))
    }

    const r = await getHotelAverages(ctx, hotel.id, { stayCheckIn: '2027-06-01', stayCheckOut: '2027-06-03', includeRoomIds: true })
    expect(r.availableStay).toMatchObject({ numerator: 2001 * 4, denominator: 2001, eligibleRoomCount: 2001 })
    expect(r.availableStay!.eligibleRoomIds).toHaveLength(2000)
    expect(new Set(r.availableStay!.eligibleRoomIds).size).toBe(2000)
    // The first 2,000 in room-number order: room 12000 (the 2,001st) is the one left out.
    expect(r.availableStay!.eligibleRoomIds).toEqual(rooms.slice(0, 2000).map(room => room.id))
    // The response contract is exactly the brief's: no extra truncation flag (ids < count says it).
    expect(Object.keys(r.availableStay!).sort()).toEqual(['basis', 'checkIn', 'checkOut', 'denominator', 'display', 'eligibleRoomCount', 'eligibleRoomIds', 'numerator', 'value'])
  })
})

describe('9. rounding through the real formatting path (half-up, 2 decimals)', () => {
  it('1/3 -> "0.33", 2/3 -> "0.67", 5/2 -> "2.50"', async () => {
    const { scope, admin, hotels: [third, half] } = await orgWithHotels([
      { rooms: [{ cap: 1 }, { cap: 0 }, { cap: 0 }] },
      { rooms: [{ cap: 2 }, { cap: 3 }] },
    ])
    const ctx = makeCtx(scope, { permissions: READ_ONLY, allHotels: true })
    expect((await getHotelAverages(ctx, third!.id, { date: '2026-10-01' })).base).toEqual({ numerator: 1, denominator: 3, value: 1 / 3, display: '0.33', basis: 'ROOMS' })

    // One of the 0-capacity rooms becomes 1 on 2027-01-01 -> 2/3.
    const rooms = await db.query.room.findMany({ where: (r, { eq }) => eq(r.hotelId, third!.id) })
    const versions = await db.query.roomBaseConfig.findMany({ where: (v, { eq }) => eq(v.hotelId, third!.id) })
    const zeroRoom = rooms.find(r => versions.find(v => v.roomId === r.id)!.sellableCapacity === 0)!
    await changeBaseConfig(admin, third!.id, zeroRoom.id, { effectiveFrom: '2027-01-01', physicalBeds: 1, sellableCapacity: 1 })
    expect((await getHotelAverages(ctx, third!.id, { date: '2027-01-01' })).base).toEqual({ numerator: 2, denominator: 3, value: 2 / 3, display: '0.67', basis: 'ROOMS' })

    expect((await getHotelAverages(ctx, half!.id, { date: '2026-10-01' })).base).toEqual({ numerator: 5, denominator: 2, value: 2.5, display: '2.50', basis: 'ROOMS' })
  })
})

describe('InventoryReadRepository isolation (cross-hotel and cross-organization)', () => {
  async function twoHotels() {
    const { scope } = await makeOrg(db)
    const admin = makeCtx(scope, { permissions: MANAGER, allHotels: true })
    const type = await makeRoomType(db, scope)
    const make = async () => {
      const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
      const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
      const room = await createRoom(admin, hotel.id, { floorId: floor.id, roomTypeId: type.id, roomNumber: '101', inServiceFrom: '2025-01-01', features: [] })
      await applyHajj(admin, hotel.id, [room.id])
      await createRoomBlock(admin, hotel.id, room.id, { kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-03', reason: 'Paint' })
      return { hotel, room }
    }
    return { scope, h1: await make(), h2: await make() }
  }
  const range = { from: '2027-01-01', to: '2027-12-31' }

  it('a hotel scope returns only its own rooms, versions, overrides and blocks', async () => {
    const { scope, h1 } = await twoHotels()
    const rows = await new InventoryReadRepository(db, trustedHotelScope(scope, h1.hotel.id)).loadRoomInputs(range, { includeBlocks: true })
    expect(rows.map(r => r.roomId)).toEqual([h1.room.id])
    expect(rows[0]!.versions).toHaveLength(1)
    expect(rows[0]!.overrides).toHaveLength(1)
    expect(rows[0]!.blocks).toHaveLength(1)
    const blocksOff = await new InventoryReadRepository(db, trustedHotelScope(scope, h1.hotel.id)).loadRoomInputs(range, { includeBlocks: false })
    expect(blocksOff[0]!.blocks).toEqual([])
  })

  it('foreign-hotel room ids in opts.roomIds never come back (same organization)', async () => {
    const { scope, h1, h2 } = await twoHotels()
    const repo = new InventoryReadRepository(db, trustedHotelScope(scope, h2.hotel.id))
    expect(await repo.loadRoomInputs(range, { roomIds: [h1.room.id], includeBlocks: true })).toEqual([])
    const mixed = await repo.loadRoomInputs(range, { roomIds: [h1.room.id, h2.room.id], includeBlocks: true })
    expect(mixed.map(r => r.roomId)).toEqual([h2.room.id])
    expect(mixed[0]!.blocks).toHaveLength(1)
  })

  it('a foreign organization holding the leaked hotel and room ids gets nothing', async () => {
    const { h1 } = await twoHotels()
    const { scope: other } = await makeOrg(db)
    const repo = new InventoryReadRepository(db, trustedHotelScope(other, h1.hotel.id))
    expect(await repo.loadRoomInputs(range, { includeBlocks: true })).toEqual([])
    expect(await repo.loadRoomInputs(range, { roomIds: [h1.room.id], includeBlocks: true })).toEqual([])
  })

  it('every one of the four statements carries its own table\'s organization_id AND hotel_id predicate, bound to the scope (captured SQL)', async () => {
    const { scope, h1 } = await twoHotels()
    const logged: Array<{ query: string, params: unknown[] }> = []
    const loggingDb = drizzle(getTestClient(), { schema, logger: { logQuery: (query, params) => logged.push({ query, params }) } }) as Database

    const rows = await new InventoryReadRepository(loggingDb, trustedHotelScope(scope, h1.hotel.id)).loadRoomInputs(range, { roomIds: [h1.room.id], includeBlocks: true })
    expect(rows).toHaveLength(1)

    const tables = ['room', 'room_base_config', 'room_capacity_override', 'room_operational_block']
    expect(logged.map(l => /from "([a-z_]+)"/.exec(l.query)![1]).sort()).toEqual([...tables].sort())
    for (const { query, params } of logged) {
      const table = /from "([a-z_]+)"/.exec(query)![1]!
      const org = new RegExp(`"${table}"\\."organization_id" = \\$(\\d+)`).exec(query)
      const hotel = new RegExp(`"${table}"\\."hotel_id" = \\$(\\d+)`).exec(query)
      expect(org, query).not.toBeNull()
      expect(hotel, query).not.toBeNull()
      expect(params[Number(org![1]) - 1]).toBe(scope.organizationId)
      expect(params[Number(hotel![1]) - 1]).toBe(h1.hotel.id)
    }
  })

  it('an empty roomIds list loads nothing; only rows overlapping the range are loaded', async () => {
    const { scope, h1 } = await twoHotels()
    const repo = new InventoryReadRepository(db, trustedHotelScope(scope, h1.hotel.id))
    expect(await repo.loadRoomInputs(range, { roomIds: [], includeBlocks: true })).toEqual([])
    const outside = await repo.loadRoomInputs({ from: '2027-08-01', to: '2027-08-31' }, { includeBlocks: true })
    expect(outside).toHaveLength(1)
    expect(outside[0]!.overrides).toEqual([])
    expect(outside[0]!.blocks).toEqual([])
    expect(await repo.loadRoomInputs({ from: '2020-01-01', to: '2020-12-31' }, { includeBlocks: true })).toEqual([])
  })

  it('several windows: rows overlapping ANY window are loaded, never rows lying only in the gap between them; [] loads nothing', async () => {
    // The room: base from 2025-01-01 (open), Hajj override 2027-05-01…07-31, MAINTENANCE block 2027-05-01…05-03.
    const { scope, h1 } = await twoHotels()
    const repo = new InventoryReadRepository(db, trustedHotelScope(scope, h1.hotel.id))
    expect(await repo.loadRoomInputs([], { includeBlocks: true })).toEqual([])

    // January and December 2027: the override and the block lie only in the gap (a hull would load both).
    const gapOnly = await repo.loadRoomInputs([{ from: '2027-12-01', to: '2027-12-31' }, { from: '2027-01-01', to: '2027-01-31' }], { includeBlocks: true })
    expect(gapOnly.map(r => r.roomId)).toEqual([h1.room.id])
    expect(gapOnly[0]!.versions).toHaveLength(1)
    expect(gapOnly[0]!.overrides).toEqual([])
    expect(gapOnly[0]!.blocks).toEqual([])

    // A second, far-away window that does touch them loads them (once each, even with overlapping windows).
    const touching = await repo.loadRoomInputs([{ from: '2027-01-01', to: '2027-01-31' }, { from: '2027-05-02', to: '2027-05-02' }, { from: '2027-05-01', to: '2027-05-03' }], { includeBlocks: true })
    expect(touching[0]!.versions).toHaveLength(1)
    expect(touching[0]!.overrides).toHaveLength(1)
    expect(touching[0]!.blocks).toHaveLength(1)
  })
})
