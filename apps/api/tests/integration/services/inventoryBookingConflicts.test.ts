import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { roomBaseConfig, roomCapacityOverride, roomOperationalBlock } from '@hajj/db/schema'
import type { Database } from '@hajj/db/client'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { ROLE_DEFINITIONS } from '@hajj/contracts/constants/roles'
import { hotelRepos } from '../../../server/repositories'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { applyOverrides, createCapacityPeriod, deleteCapacityPeriod, deleteOverride, listOverrides, removeOverrides, updateCapacityPeriod } from '../../../server/services/capacityPeriodService'
import { deactivateFloor } from '../../../server/services/floorService'
import { updateSettings } from '../../../server/services/hotelService'
import { bulkCreateRoomBlocks, createRoomBlock } from '../../../server/services/operationalBlockService'
import { changeBaseConfig, createRoom, reactivateRoom, retireRoom } from '../../../server/services/roomService'
import { makeAgency, makeBooking, makeBookingRoom, makeGuest, makeStay } from '../../support/bookingFixtures'
import { makeFloor, makeHotel, makeOrg, makeRoomType, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

/**
 * Step 9 (design v7 §10 "inventory changes can break confirmed bookings"): every Phase 1 inventory write that
 * can take nights or seats away from a room re-checks the live bookings on the changed nights, under the room
 * locks, and refuses with 409 BOOKING_CONFLICT (listing the bookings) — nothing is written. Plus the Phase 1
 * lock gaps v7 names (floor deactivation, room reactivation, capacity-period and override deletion).
 */

const db = getTestDb()
const client = getTestClient()

afterEach(async () => {
  vi.restoreAllMocks()
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions as Permission[]
const NOW = () => new Date('2026-09-25T12:00:00Z') // UTC hotel: today = 2026-09-25

function makeCtx(scope: OrganizationScope, userId: string, hotelId: string): AuthContext {
  return {
    identity: { userId, organizationId: scope.organizationId, email: 'manager@test.com', fullName: 'Manager' },
    authz: { permissions: new Set(MANAGER), allHotels: false, hotelIds: new Set([hotelId]) },
    scope,
    db: db as Database,
    now: NOW,
  }
}

/** A UTC hotel with two four-seat rooms (401, 402) in service from 2025, and an approved agency. */
async function setup() {
  const { scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const floor = await makeFloor(db, hotelScope)
  const roomType = await makeRoomType(db, scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  const manager = await makeUser(db, scope, { fullName: 'Inventory Manager' })
  const ctx = makeCtx(scope, manager.id, hotel.id)
  const newRoom = (roomNumber: string) => createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber, inServiceFrom: '2025-01-01', features: [] })
  const [room, other] = [await newRoom('401'), await newRoom('402')]
  const agency = await makeAgency(db, scope)
  return { scope, hotel, hotelScope, floor, roomType, ctx, room, other, agency }
}

type Env = Awaited<ReturnType<typeof setup>>

interface BookOptions { checkIn?: string, checkOut?: string, status?: string, holdExpiresAt?: Date, cancelledAt?: Date, extraBeds?: number }

/** A booking holding `seats` pilgrims in `roomId` for [checkIn, checkOut) (confirmed unless told otherwise). */
async function book(env: Env, roomId: string, seats: number, options: BookOptions = {}) {
  const { checkIn = '2027-06-01', checkOut = '2027-06-06', extraBeds = 0, ...rest } = options
  const b = await makeBooking(db, env.scope, env.hotel.id, { agencyId: env.agency.id, checkIn, checkOut, maleCount: seats, totalCount: seats, ...rest })
  const claim = await makeBookingRoom(db, env.scope, b, roomId, { extraBeds })
  for (let slot = 1; slot <= seats; slot++) {
    const guest = await makeGuest(db, env.scope, b.id, slot)
    await makeStay(db, env.scope, b.id, guest.id, claim.id, checkIn, checkOut)
  }
  return b
}

interface Refusal { code: string, httpStatus: number, details: { bookings: Array<Record<string, unknown>> } }

/** The rejection of `call`, as the domain error a route would render. */
async function rejection(call: Promise<unknown>): Promise<Refusal> {
  const error = await call.then(() => null, (e: unknown) => e)
  if (!error) throw new Error('expected the call to be refused')
  return error as Refusal
}

const versionsOf = (roomId: string) => db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, roomId))
const blocksOf = (roomId: string) => db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, roomId))
const overridesOf = (roomId: string) => db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, roomId))

describe('retiring a room', () => {
  it('is refused while a live booking holds the room on or after the retirement date; nothing changes', async () => {
    const env = await setup()
    const b = await book(env, env.room.id, 2)
    const before = await versionsOf(env.room.id)

    const error = await rejection(retireRoom(env.ctx, env.hotel.id, env.room.id, { effectiveFrom: '2027-06-04' }))

    expect(error).toMatchObject({ code: 'BOOKING_CONFLICT', httpStatus: 409 })
    expect(error.details.bookings).toEqual([{ bookingId: b.id, bookingNo: b.bookingNo, roomId: env.room.id, from: '2027-06-04', to: '2027-06-05', reason: 'NOT_SELLABLE' }])
    expect(await versionsOf(env.room.id)).toEqual(before)
  })

  it('is allowed from the booking\'s check-out day on, and past expired holds or cancelled bookings', async () => {
    const env = await setup()
    await book(env, env.room.id, 2)
    await book(env, env.room.id, 1, { checkIn: '2027-07-01', checkOut: '2027-07-05', status: 'HELD', holdExpiresAt: new Date(Date.now() - 1000) })
    await book(env, env.room.id, 1, { checkIn: '2027-08-01', checkOut: '2027-08-05', status: 'CANCELLED', cancelledAt: new Date() })

    await retireRoom(env.ctx, env.hotel.id, env.room.id, { effectiveFrom: '2027-06-06' })
  })
})

describe('changing a room\'s base capacity', () => {
  it('may not drop below the pilgrims booked on any later night; extra beds count as capacity', async () => {
    const env = await setup()
    const b = await book(env, env.room.id, 3, { extraBeds: 1 })

    const error = await rejection(changeBaseConfig(env.ctx, env.hotel.id, env.room.id, { effectiveFrom: '2027-06-03', physicalBeds: 1, sellableCapacity: 1 }))
    expect(error.details.bookings).toEqual([{ bookingId: b.id, bookingNo: b.bookingNo, roomId: env.room.id, from: '2027-06-03', to: '2027-06-05', reason: 'OVER_CAPACITY' }])

    await changeBaseConfig(env.ctx, env.hotel.id, env.room.id, { effectiveFrom: '2027-06-03', physicalBeds: 2, sellableCapacity: 2 })
  })

  it('a change after the booking leaves it untouched', async () => {
    const env = await setup()
    await book(env, env.room.id, 4)
    await changeBaseConfig(env.ctx, env.hotel.id, env.room.id, { effectiveFrom: '2027-06-06', physicalBeds: 1, sellableCapacity: 1 })
  })
})

describe('operational blocks', () => {
  it('a sale-blocking block over booked nights is refused and not saved; next to the stay it is fine', async () => {
    const env = await setup()
    const b = await book(env, env.room.id, 1)

    const error = await rejection(createRoomBlock(env.ctx, env.hotel.id, env.room.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-06-05', endDate: '2027-06-10', reason: 'Pipe burst' }))
    expect(error.details.bookings).toEqual([expect.objectContaining({ bookingNo: b.bookingNo, from: '2027-06-05', to: '2027-06-05', reason: 'NOT_SELLABLE' })])
    expect(await blocksOf(env.room.id)).toEqual([])

    await createRoomBlock(env.ctx, env.hotel.id, env.room.id, { kind: 'OUT_OF_SERVICE', startDate: '2027-06-06', endDate: '2027-06-10', reason: 'Pipe burst' })
  })

  it('maintenance blocks only conflict when maintenance blocks sales (hotel setting)', async () => {
    const env = await setup()
    await book(env, env.room.id, 1)
    const block = { kind: 'MAINTENANCE' as const, startDate: '2027-06-02', endDate: '2027-06-03', reason: 'Painting' }
    expect((await rejection(createRoomBlock(env.ctx, env.hotel.id, env.room.id, block))).code).toBe('BOOKING_CONFLICT')

    await hotelRepos(db, env.hotelScope).settings.upsert('inventory.maintenanceBlocksSales', false)
    await createRoomBlock(env.ctx, env.hotel.id, env.room.id, block)
  })

  it('switching maintenance back to blocking sales is refused while a booking sits on a maintenance night', async () => {
    const env = await setup()
    await updateSettings(env.ctx, env.hotel.id, { 'inventory.maintenanceBlocksSales': false })
    await createRoomBlock(env.ctx, env.hotel.id, env.room.id, { kind: 'MAINTENANCE', startDate: '2027-06-02', endDate: '2027-06-03', reason: 'Painting' })
    const b = await book(env, env.room.id, 1)

    const error = await rejection(updateSettings(env.ctx, env.hotel.id, { 'inventory.maintenanceBlocksSales': true }))
    expect(error.details.bookings).toEqual([expect.objectContaining({ bookingNo: b.bookingNo, from: '2027-06-02', to: '2027-06-03', reason: 'NOT_SELLABLE' })])
    expect((await hotelRepos(db, env.hotelScope).settings.getAll()).find(r => r.key === 'inventory.maintenanceBlocksSales')?.value).toBe(false)
  })

  it('a bulk block is all or nothing: one booked room refuses the whole request', async () => {
    const env = await setup()
    await book(env, env.other.id, 1)

    const error = await rejection(bulkCreateRoomBlocks(env.ctx, env.hotel.id, { roomIds: [env.room.id, env.other.id], kind: 'OPERATIONAL_BLOCK', startDate: '2027-06-01', endDate: '2027-06-02', reason: 'Event' }))
    expect(error.details.bookings).toEqual([expect.objectContaining({ roomId: env.other.id })])
    expect([...await blocksOf(env.room.id), ...await blocksOf(env.other.id)]).toEqual([])
  })
})

describe('seasonal capacity', () => {
  const period = { name: 'Hajj 2027', kind: 'HAJJ' as const, startDate: '2027-06-01', endDate: '2027-06-10' }

  it('an override lowering capacity under the booked pilgrims is refused and not saved', async () => {
    const env = await setup()
    await book(env, env.room.id, 3)
    const p = await createCapacityPeriod(env.ctx, env.hotel.id, period)

    const error = await rejection(applyOverrides(env.ctx, env.hotel.id, p.id, { selector: { roomIds: [env.room.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 2, sellableCapacity: 2 }, onConflict: 'FAIL' }))
    expect(error.details.bookings).toEqual([expect.objectContaining({ reason: 'OVER_CAPACITY', from: '2027-06-01', to: '2027-06-05' })])
    expect(await overridesOf(env.room.id)).toEqual([])
  })

  it('removing a raising override (one or in bulk) or shrinking its period may not strand the extra pilgrims', async () => {
    const env = await setup()
    const p = await createCapacityPeriod(env.ctx, env.hotel.id, period)
    await applyOverrides(env.ctx, env.hotel.id, p.id, { selector: { roomIds: [env.room.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, onConflict: 'FAIL' })
    await book(env, env.room.id, 5, { checkIn: '2027-06-08', checkOut: '2027-06-10' })
    const [override] = await listOverrides(env.ctx, env.hotel.id, p.id)

    expect((await rejection(deleteOverride(env.ctx, env.hotel.id, p.id, override!.id))).code).toBe('BOOKING_CONFLICT')
    expect((await rejection(removeOverrides(env.ctx, env.hotel.id, p.id, { overrideIds: [override!.id] }))).code).toBe('BOOKING_CONFLICT')
    const shrunk = await rejection(updateCapacityPeriod(env.ctx, env.hotel.id, p.id, { endDate: '2027-06-08' }))
    expect(shrunk.details.bookings).toEqual([expect.objectContaining({ from: '2027-06-09', to: '2027-06-09', reason: 'OVER_CAPACITY' })])
    expect(await overridesOf(env.room.id)).toHaveLength(1)

    await updateCapacityPeriod(env.ctx, env.hotel.id, p.id, { endDate: '2027-06-12' })
  })

  it('extending a lowering override\'s period over booked nights is refused (nights joining the period)', async () => {
    const env = await setup()
    const p = await createCapacityPeriod(env.ctx, env.hotel.id, period)
    await applyOverrides(env.ctx, env.hotel.id, p.id, { selector: { roomIds: [env.room.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 2, sellableCapacity: 2 }, onConflict: 'FAIL' })
    await book(env, env.room.id, 3, { checkIn: '2027-06-11', checkOut: '2027-06-13' })

    const error = await rejection(updateCapacityPeriod(env.ctx, env.hotel.id, p.id, { endDate: '2027-06-11' }))
    expect(error.details.bookings).toEqual([expect.objectContaining({ from: '2027-06-11', to: '2027-06-11', reason: 'OVER_CAPACITY' })])
  })
})

describe('Phase 1 lock gaps (v7 §10)', () => {
  /** Holds a row lock from another connection while `call` runs, and proves `call` waits for it. */
  async function expectToWaitFor(lockStatement: (sql: typeof client) => PromiseLike<unknown>, call: () => Promise<unknown>) {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let locked!: () => void
    const lockTaken = new Promise<void>((resolve) => { locked = resolve })
    const holder = client.begin(async (sql) => {
      await lockStatement(sql as unknown as typeof client)
      locked()
      await released
    })
    await lockTaken
    const pending = call()
    try {
      await vi.waitFor(async () => {
        const [row] = await client<Array<{ n: number }>>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
        if (!row || row.n < 1) throw new Error('the call never waited on the held row lock')
      }, { timeout: 5_000, interval: 20 })
    }
    finally {
      release()
      await holder
    }
    return pending
  }

  it('floor deactivation locks the floor row', async () => {
    const env = await setup()
    const emptyFloor = await makeFloor(db, env.hotelScope)
    await expectToWaitFor(sql => sql`select id from floor where id = ${emptyFloor.id} for update`, () => deactivateFloor(env.ctx, env.hotel.id, emptyFloor.id))
  })

  it('room creation locks its floor, so it cannot land on a floor being deactivated', async () => {
    const env = await setup()
    const input = { floorId: env.floor.id, roomTypeId: env.roomType.id, roomNumber: '403', inServiceFrom: '2025-01-01', features: [] }
    await expectToWaitFor(sql => sql`select id from floor where id = ${env.floor.id} for update`, () => createRoom(env.ctx, env.hotel.id, input))
  })

  it('room reactivation locks the room (and its floor); it needs an active floor', async () => {
    const env = await setup()
    await retireRoom(env.ctx, env.hotel.id, env.room.id, { effectiveFrom: '2027-01-01' })
    const input = { effectiveFrom: '2027-03-01', physicalBeds: 4, sellableCapacity: 4 }
    await expectToWaitFor(sql => sql`select id from room where id = ${env.room.id} for update`, () => reactivateRoom(env.ctx, env.hotel.id, env.room.id, input))

    await retireRoom(env.ctx, env.hotel.id, env.room.id, { effectiveFrom: '2027-04-01' })
    await client`update floor set is_active = false where id = ${env.floor.id}`
    expect(await rejection(reactivateRoom(env.ctx, env.hotel.id, env.room.id, { ...input, effectiveFrom: '2027-05-01' }))).toMatchObject({ code: 'FLOOR_INACTIVE' })
  })

  it('deleting an override or a capacity period locks the period row first', async () => {
    const env = await setup()
    const p = await createCapacityPeriod(env.ctx, env.hotel.id, { name: 'Ramadan', kind: 'RAMADAN', startDate: '2027-03-01', endDate: '2027-03-10' })
    await applyOverrides(env.ctx, env.hotel.id, p.id, { selector: { roomIds: [env.room.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 }, onConflict: 'FAIL' })
    const [override] = await listOverrides(env.ctx, env.hotel.id, p.id)
    const lockPeriod = (sql: typeof client) => sql`select id from capacity_period where id = ${p.id} for update`

    await expectToWaitFor(lockPeriod, () => deleteOverride(env.ctx, env.hotel.id, p.id, override!.id))
    await expectToWaitFor(lockPeriod, () => deleteCapacityPeriod(env.ctx, env.hotel.id, p.id))
  })
})
