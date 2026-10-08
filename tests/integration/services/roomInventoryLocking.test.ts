import { AsyncLocalStorage } from 'node:async_hooks'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLog, capacityPeriod as capacityPeriodTable, roomCapacityOverride, roomOperationalBlock } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { CapacityPeriodRepository, RoomBaseConfigRepository, RoomRepository } from '../../../server/repositories/hotel'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import type { Permission } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { applyOverrides, createCapacityPeriod, updateCapacityPeriod } from '../../../server/services/capacityPeriodService'
import { bulkCreateRoomBlocks, createRoomBlock } from '../../../server/services/operationalBlockService'
import { changeBaseConfig, createRoom, retireRoom } from '../../../server/services/roomService'
import { makeFloor, makeHotel, makeOrg, makeRoomType, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

/**
 * Task 16 fix round — the room row is the serialization point between retirement and every
 * room-level dated-inventory write (block create, bulk block create, override apply). Each of those
 * transactions takes `SELECT ... FOR UPDATE` on the room row(s) BEFORE its inventory / retirement
 * conflict checks, so whichever transaction locks first commits first and the other re-checks on the
 * committed state. Without that lock both transactions read the pre-conflict state, both pass their
 * checks, and a block/override can survive on nights after the room's retirement date.
 *
 * N1 follow-up: a capacity period date edit moves every override row of the period (FK cascade), so
 * it takes the period row lock and then the overridden rooms' locks before its coverage check;
 * override apply takes the same period row lock first. Lock order for both: period, then rooms
 * (ascending id).
 *
 * N2 follow-up: a base-capacity change closes the open base version and inserts the next one, the
 * same rows retirement closes, so it takes the room row lock first as well. Without it the two
 * transactions either deadlock (40P01: the change holds the open version's row lock and its insert's
 * FK check waits on retirement's room lock, while retirement waits on that version row) or the
 * change overwrites the version retirement just closed and re-opens the room (lost update).
 */

const db = getTestDb()

afterEach(async () => {
  vi.restoreAllMocks()
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions as Permission[]
const NOW = () => new Date('2026-09-25T12:00:00Z') // UTC hotel: today = 2026-09-25
const RACE_TIMEOUT_MS = 20_000

function makeCtx(scope: OrganizationScope, userId: string, hotelId: string): AuthContext {
  return {
    identity: { userId, organizationId: scope.organizationId, email: 'manager@test.com', fullName: 'Manager' },
    authz: { permissions: new Set(MANAGER), allHotels: false, hotelIds: new Set([hotelId]) },
    scope,
    db: db as Database,
    now: NOW,
  }
}

async function setup() {
  const { scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const hotelScope = trustedHotelScope(scope, hotel.id)
  const floor = await makeFloor(db, hotelScope)
  const roomType = await makeRoomType(db, scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  const manager = await makeUser(db, scope, { fullName: 'Lock Manager' })
  const ctx = makeCtx(scope, manager.id, hotel.id)
  const room = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: '2025-01-01', features: [] })
  return { scope, hotel, hotelScope, floor, roomType, ctx, room }
}

/** Rejects with a clear message instead of hanging when a barrier is never reached. */
function withTimeout<T>(promise: Promise<T>, what: string, ms = 8_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), ms)),
  ])
}

/**
 * Deterministic lock-order control for two concurrent transactions on the same room(s) — or, with
 * `point: 'period'`, on the same capacity period.
 *
 * Each operation runs in a named lane (AsyncLocalStorage). The FIRST lock call of each lane at the
 * chosen lock point is gated — `'room'`: `RoomRepository.findById` / `lockByIds`; `'period'`:
 * `CapacityPeriodRepository.findById({ forUpdate: true })` (the lock-acquisition point inside its
 * transaction):
 *   1. barrier: neither lane may issue its lock statement until BOTH transactions are open and have
 *      reached the lock-acquisition point (so both start from the same pre-conflict state);
 *   2. the `first` lane then takes the lock for real and holds it (its transaction stays open) until
 *      the `second` lane has issued its own locking statement AND PostgreSQL reports that backend as
 *      waiting on a row lock (`pg_stat_activity.wait_event_type = 'Lock'`) — proof the second really
 *      serializes behind the first instead of racing it on a stale read;
 *   3. only then does the `first` lane continue (checks, writes, commit); the `second` lane's lock
 *      statement returns after that commit, and its checks run on the committed state.
 * Without the row lock at that point (in the `second` lane's code path) step 2 can never be observed
 * and the test fails on the timeout.
 */
function orderLocks(first: string, second: string, point: 'room' | 'period') {
  const lanes = new AsyncLocalStorage<string>()
  const events: string[] = []
  const gated = new Set<string>()
  let arrived = 0
  let releaseBoth!: () => void
  const bothAtLock = new Promise<void>((resolve) => { releaseBoth = resolve })
  let releaseSecond!: () => void
  const secondMayLock = new Promise<void>((resolve) => { releaseSecond = resolve })

  async function gate<T>(lockCall: () => Promise<T>): Promise<T> {
    const lane = lanes.getStore()
    if (!lane || gated.has(lane)) return lockCall()
    gated.add(lane)
    events.push(`${lane}:at-lock`)
    if (++arrived === 2) releaseBoth()
    await withTimeout(bothAtLock, `both transactions to reach the ${point} lock`)

    if (lane === first) {
      const result = await lockCall()
      events.push(`${lane}:locked`)
      releaseSecond()
      await vi.waitFor(async () => {
        const [row] = await getTestClient()<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%for update%'`
        if (!row || row.n < 1) throw new Error(`the ${second} transaction never blocked on the ${point}-row lock held by ${first}`)
      }, { timeout: 8_000, interval: 10 })
      events.push(`${second}:observed-waiting`)
      return result
    }

    await secondMayLock
    events.push(`${lane}:requesting`)
    const result = await lockCall()
    events.push(`${lane}:locked`)
    return result
  }

  if (point === 'room') {
    const realFindById = RoomRepository.prototype.findById
    const realLockByIds = RoomRepository.prototype.lockByIds
    vi.spyOn(RoomRepository.prototype, 'findById').mockImplementation(function (this: RoomRepository, ...args) {
      return gate(() => realFindById.apply(this, args))
    })
    vi.spyOn(RoomRepository.prototype, 'lockByIds').mockImplementation(function (this: RoomRepository, ...args) {
      return gate(() => realLockByIds.apply(this, args))
    })
  }
  else {
    const realFindPeriod = CapacityPeriodRepository.prototype.findById
    vi.spyOn(CapacityPeriodRepository.prototype, 'findById').mockImplementation(function (this: CapacityPeriodRepository, ...args) {
      return args[1]?.forUpdate ? gate(() => realFindPeriod.apply(this, args)) : realFindPeriod.apply(this, args)
    })
  }

  return {
    events,
    run: <T>(lane: string, fn: () => Promise<T>): Promise<T> => lanes.run(lane, fn),
    /** The exact lock choreography every race below must show. */
    expectedEvents: () => [`${first}:locked`, `${second}:requesting`, `${second}:observed-waiting`, `${second}:locked`],
  }
}

const orderRoomLocks = (first: string, second: string) => orderLocks(first, second, 'room')
const orderPeriodLocks = (first: string, second: string) => orderLocks(first, second, 'period')

function settledOutcome<T>(result: PromiseSettledResult<T>) {
  return result.status === 'fulfilled' ? { ok: true as const, value: result.value } : { ok: false as const, error: result.reason as unknown }
}

async function versionsOf(hotelScope: ReturnType<typeof trustedHotelScope>, roomId: string) {
  return new RoomBaseConfigRepository(db, hotelScope).versionsForRoom(roomId)
}

/** The room's last night in inventory, or null while its newest version is open-ended. */
async function lastNightOf(hotelScope: ReturnType<typeof trustedHotelScope>, roomId: string): Promise<string | null> {
  const versions = await versionsOf(hotelScope, roomId)
  const newest = [...versions].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).at(-1)!
  return newest.validTo
}

async function auditActions(hotelId: string) {
  return db.select().from(auditLog).where(eq(auditLog.hotelId, hotelId))
}

/** The documented invariant, checked on the committed DB state: no active block / no override covers a night after the room's last night in inventory. */
async function expectNothingPastRetirement(hotelScope: ReturnType<typeof trustedHotelScope>, roomId: string) {
  const lastNight = await lastNightOf(hotelScope, roomId)
  if (lastNight === null) return
  const blocks = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, roomId))
  for (const b of blocks.filter(b => b.cancelledAt === null)) expect(b.endDate <= lastNight, `block ${b.startDate}..${b.endDate} outlives last night ${lastNight}`).toBe(true)
  const overrides = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, roomId))
  for (const o of overrides) expect(o.validTo <= lastNight, `override ${o.validFrom}..${o.validTo} outlives last night ${lastNight}`).toBe(true)
}

// ---------------------------------------------------------------------------

describe('retireRoom vs createRoomBlock on the same room (room-row lock, both acquisition orders)', () => {
  const BLOCK = { kind: 'MAINTENANCE' as const, startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Leak' }
  const RETIRE = { effectiveFrom: '2026-10-05' } // last night in inventory 10-04 — inside the block

  it('retirement locks first: it commits, the waiting block re-checks coverage on the committed state -> 422 ROOM_NOT_IN_INVENTORY_FOR_BLOCK; no block row, no BLOCK_CREATED audit', async () => {
    const { hotel, hotelScope, ctx, room } = await setup()
    const race = orderRoomLocks('retire', 'block')

    const [retired, blocked] = (await Promise.allSettled([
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
      race.run('block', () => createRoomBlock(ctx, hotel.id, room.id, BLOCK)),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['block:at-lock', 'retire:at-lock']) // barrier: both reached the lock point first
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(retired!.ok).toBe(true)
    expect(blocked!.ok).toBe(false)
    expect(!blocked!.ok && blocked!.error).toMatchObject({ code: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK', httpStatus: 422 })

    expect(await lastNightOf(hotelScope, room.id)).toBe('2026-10-04')
    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, room.id))).toEqual([])
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'BLOCK_CREATED')).toEqual([])
    expect(audits.filter(a => a.action === 'ROOM_RETIRED').map(a => a.entityId)).toEqual([room.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)

  it('the block locks first: it commits, the waiting retirement re-runs its guard on the committed state -> 409 ROOM_HAS_ACTIVE_BLOCKS; room unchanged, no ROOM_RETIRED audit', async () => {
    const { hotel, hotelScope, ctx, room } = await setup()
    const race = orderRoomLocks('block', 'retire')

    const [retired, blocked] = (await Promise.allSettled([
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
      race.run('block', () => createRoomBlock(ctx, hotel.id, room.id, BLOCK)),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['block:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(blocked!.ok).toBe(true)
    expect(retired!.ok).toBe(false)
    expect(!retired!.ok && retired!.error).toMatchObject({ code: 'ROOM_HAS_ACTIVE_BLOCKS', httpStatus: 409 })

    const versions = await versionsOf(hotelScope, room.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ validFrom: '2025-01-01', validTo: null })
    const blocks = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, room.id))
    expect(blocks).toHaveLength(1)
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'ROOM_RETIRED')).toEqual([])
    expect(audits.filter(a => a.action === 'BLOCK_CREATED').map(a => a.entityId)).toEqual([blocks[0]!.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)
})

describe('retireRoom vs bulkCreateRoomBlocks (lockByIds) on the same room, both acquisition orders', () => {
  const RETIRE = { effectiveFrom: '2026-10-05' }

  it('retirement locks first -> the bulk request 409 BLOCK_CONFLICT (ROOM_NOT_IN_INVENTORY_FOR_BLOCK), nothing written, no block audit rows', async () => {
    const { hotel, hotelScope, floor, roomType, ctx, room } = await setup()
    const other = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: '2025-01-01', features: [] })
    const race = orderRoomLocks('retire', 'bulk')

    const [retired, bulk] = (await Promise.allSettled([
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
      race.run('bulk', () => bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Works', roomIds: [other.id, room.id] })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['bulk:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(retired!.ok).toBe(true)
    expect(!bulk!.ok && bulk!.error).toMatchObject({ code: 'BLOCK_CONFLICT', httpStatus: 409, details: { conflicts: [{ roomId: room.id, roomNumber: '401', reason: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK' }] } })
    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.hotelId, hotel.id))).toEqual([])
    expect((await auditActions(hotel.id)).filter(a => a.action === 'BLOCK_CREATED' || a.action === 'BLOCKS_BULK_CREATED')).toEqual([])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)

  it('the bulk create locks first -> the retirement 409 ROOM_HAS_ACTIVE_BLOCKS, room unchanged, no ROOM_RETIRED audit', async () => {
    const { hotel, hotelScope, floor, roomType, ctx, room } = await setup()
    const other = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: '2025-01-01', features: [] })
    const race = orderRoomLocks('bulk', 'retire')

    const [retired, bulk] = (await Promise.allSettled([
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
      race.run('bulk', () => bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Works', roomIds: [other.id, room.id] })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['bulk:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(bulk!.ok).toBe(true)
    expect(!retired!.ok && retired!.error).toMatchObject({ code: 'ROOM_HAS_ACTIVE_BLOCKS', httpStatus: 409 })
    expect(await lastNightOf(hotelScope, room.id)).toBeNull()
    expect((await auditActions(hotel.id)).filter(a => a.action === 'ROOM_RETIRED')).toEqual([])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)
})

describe('retireRoom vs applyOverrides on the same room (room-row lock, both acquisition orders)', () => {
  const RETIRE = { effectiveFrom: '2027-06-15' } // last night in inventory 2027-06-14 — inside the period
  const SPEC = { mode: 'ABSOLUTE' as const, physicalBeds: 6, sellableCapacity: 6 }

  async function setupWithPeriod() {
    const base = await setup()
    const period = await createCapacityPeriod(base.ctx, base.hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    return { ...base, period }
  }

  it('retirement locks first: it commits, the waiting apply re-checks coverage on the committed state -> 409 OVERRIDE_CONFLICT (NOT_IN_INVENTORY_FOR_PERIOD); no override row, no CAPACITY_OVERRIDES_APPLIED audit', async () => {
    const { hotel, hotelScope, ctx, room, period } = await setupWithPeriod()
    const race = orderRoomLocks('retire', 'apply')

    const [retired, applied] = (await Promise.allSettled([
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
      race.run('apply', () => applyOverrides(ctx, hotel.id, period.id, { selector: { roomIds: [room.id] }, spec: SPEC, onConflict: 'FAIL' })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['apply:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(retired!.ok).toBe(true)
    expect(!applied!.ok && applied!.error).toMatchObject({ code: 'OVERRIDE_CONFLICT', httpStatus: 409, details: { skipped: [{ roomId: room.id, roomNumber: '401', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] } })

    expect(await lastNightOf(hotelScope, room.id)).toBe('2027-06-14')
    expect(await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, room.id))).toEqual([])
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'CAPACITY_OVERRIDES_APPLIED')).toEqual([])
    expect(audits.filter(a => a.action === 'ROOM_RETIRED').map(a => a.entityId)).toEqual([room.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)

  it('retirement locks first, onConflict SKIP: the apply commits with the room skipped (NOT_IN_INVENTORY_FOR_PERIOD) and writes no override row', async () => {
    const { hotel, hotelScope, ctx, room, period } = await setupWithPeriod()
    const race = orderRoomLocks('retire', 'apply')

    const [retired, applied] = (await Promise.allSettled([
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
      race.run('apply', () => applyOverrides(ctx, hotel.id, period.id, { selector: { roomIds: [room.id] }, spec: SPEC, onConflict: 'SKIP' })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(retired!.ok).toBe(true)
    expect(applied!.ok && applied!.value).toEqual({ applied: 0, skipped: [{ roomId: room.id, roomNumber: '401', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] })
    expect(await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, room.id))).toEqual([])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)

  it('the apply locks first: it commits, the waiting retirement re-runs its guard on the committed state -> 409 ROOM_HAS_FUTURE_OVERRIDES; room unchanged, no ROOM_RETIRED audit', async () => {
    const { hotel, hotelScope, ctx, room, period } = await setupWithPeriod()
    const race = orderRoomLocks('apply', 'retire')

    const [retired, applied] = (await Promise.allSettled([
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
      race.run('apply', () => applyOverrides(ctx, hotel.id, period.id, { selector: { roomIds: [room.id] }, spec: SPEC, onConflict: 'FAIL' })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['apply:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(applied!.ok && applied!.value).toEqual({ applied: 1, skipped: [] })
    expect(!retired!.ok && retired!.error).toMatchObject({ code: 'ROOM_HAS_FUTURE_OVERRIDES', httpStatus: 409 })

    const versions = await versionsOf(hotelScope, room.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ validFrom: '2025-01-01', validTo: null })
    expect(await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, room.id))).toHaveLength(1)
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'ROOM_RETIRED')).toEqual([])
    expect(audits.filter(a => a.action === 'CAPACITY_OVERRIDES_APPLIED').map(a => a.entityId)).toEqual([period.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)
})

/**
 * The room's committed base-version history is coherent: oldest first, every version but the newest
 * is closed, each range is valid, and no two ranges share a night (a gap is legitimate).
 */
async function expectCoherentHistory(hotelScope: ReturnType<typeof trustedHotelScope>, roomId: string) {
  const versions = [...await versionsOf(hotelScope, roomId)].sort((a, b) => a.validFrom.localeCompare(b.validFrom))
  versions.forEach((v, i) => {
    if (v.validTo !== null) expect(v.validFrom <= v.validTo, `version ${v.validFrom}..${v.validTo} is inverted`).toBe(true)
    if (i < versions.length - 1) {
      expect(v.validTo, `only the newest version may be open-ended (open version from ${v.validFrom})`).not.toBeNull()
      expect(v.validTo! < versions[i + 1]!.validFrom, `versions ${v.validFrom}..${v.validTo} and ${versions[i + 1]!.validFrom}.. overlap`).toBe(true)
    }
  })
  return versions
}

/** Task 16 fix round (N2): a base-capacity change closes/inserts the same base-version rows retirement closes, so both serialize on the room lock. */
describe('changeBaseConfig vs retireRoom on the same room (room-row lock, both acquisition orders)', () => {
  const BASE = { effectiveFrom: '2026-11-01', physicalBeds: 6, sellableCapacity: 5, reason: 'Extra beds' }

  it('the base change locks first: it commits, the waiting retirement re-reads the NEW open version and retires it (retirement after the change) -> both commit, coherent history, one audit row each', async () => {
    const { hotel, hotelScope, ctx, room } = await setup()
    const race = orderRoomLocks('base', 'retire')

    const [changed, retired] = (await Promise.allSettled([
      race.run('base', () => changeBaseConfig(ctx, hotel.id, room.id, BASE)),
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, { effectiveFrom: '2026-12-01' })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['base:at-lock', 'retire:at-lock']) // barrier: both reached the lock point first
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(changed!.ok).toBe(true)
    expect(retired!.ok).toBe(true)

    const versions = await expectCoherentHistory(hotelScope, room.id)
    expect(versions.map(v => ({ validFrom: v.validFrom, validTo: v.validTo, physicalBeds: v.physicalBeds, sellableCapacity: v.sellableCapacity }))).toEqual([
      { validFrom: '2025-01-01', validTo: '2026-10-31', physicalBeds: 4, sellableCapacity: 4 },
      { validFrom: '2026-11-01', validTo: '2026-11-30', physicalBeds: 6, sellableCapacity: 5 },
    ])
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'ROOM_BASE_CHANGED').map(a => ({ entityId: a.entityId, before: a.beforeData, after: a.afterData }))).toEqual([
      { entityId: room.id, before: { validTo: null, physicalBeds: 4, sellableCapacity: 4 }, after: { validFrom: '2026-11-01', physicalBeds: 6, sellableCapacity: 5 } },
    ])
    // The retirement closed the version the base change opened — it saw the committed change, not the stale pre-change row.
    expect(audits.filter(a => a.action === 'ROOM_RETIRED').map(a => ({ entityId: a.entityId, before: a.beforeData, after: a.afterData }))).toEqual([
      { entityId: room.id, before: { validTo: null }, after: { validTo: '2026-11-30' } },
    ])
  }, RACE_TIMEOUT_MS)

  it('the base change locks first: it commits, the waiting retirement (dated before the change) re-reads the NEW open version -> 409 RETIRE_BEFORE_CURRENT; the change stands, no ROOM_RETIRED audit', async () => {
    const { hotel, hotelScope, ctx, room } = await setup()
    const race = orderRoomLocks('base', 'retire')

    const [changed, retired] = (await Promise.allSettled([
      race.run('base', () => changeBaseConfig(ctx, hotel.id, room.id, BASE)),
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, { effectiveFrom: '2026-10-15' })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['base:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(changed!.ok).toBe(true)
    expect(!retired!.ok && retired!.error).toMatchObject({ code: 'RETIRE_BEFORE_CURRENT', httpStatus: 409 })

    const versions = await expectCoherentHistory(hotelScope, room.id)
    expect(versions.map(v => ({ validFrom: v.validFrom, validTo: v.validTo, physicalBeds: v.physicalBeds, sellableCapacity: v.sellableCapacity }))).toEqual([
      { validFrom: '2025-01-01', validTo: '2026-10-31', physicalBeds: 4, sellableCapacity: 4 },
      { validFrom: '2026-11-01', validTo: null, physicalBeds: 6, sellableCapacity: 5 },
    ])
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'ROOM_RETIRED')).toEqual([])
    expect(audits.filter(a => a.action === 'ROOM_BASE_CHANGED').map(a => a.entityId)).toEqual([room.id])
  }, RACE_TIMEOUT_MS)

  it('the retirement locks first: it commits, the waiting base change re-reads the CLOSED version -> 409 ROOM_NOT_IN_INVENTORY; the retirement is not undone (no re-opened version), no ROOM_BASE_CHANGED audit', async () => {
    const { hotel, hotelScope, ctx, room } = await setup()
    const race = orderRoomLocks('retire', 'base')

    const [changed, retired] = (await Promise.allSettled([
      race.run('base', () => changeBaseConfig(ctx, hotel.id, room.id, BASE)),
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, { effectiveFrom: '2026-12-01' })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['base:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(retired!.ok).toBe(true)
    // Valid against the pre-retirement state (11-01 is after the open version's start), refused on the committed one.
    expect(!changed!.ok && changed!.error).toMatchObject({ code: 'ROOM_NOT_IN_INVENTORY', httpStatus: 409 })

    const versions = await expectCoherentHistory(hotelScope, room.id)
    expect(versions.map(v => ({ validFrom: v.validFrom, validTo: v.validTo, physicalBeds: v.physicalBeds, sellableCapacity: v.sellableCapacity }))).toEqual([
      { validFrom: '2025-01-01', validTo: '2026-11-30', physicalBeds: 4, sellableCapacity: 4 },
    ])
    expect(await lastNightOf(hotelScope, room.id)).toBe('2026-11-30')
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'ROOM_BASE_CHANGED')).toEqual([])
    expect(audits.filter(a => a.action === 'ROOM_RETIRED').map(a => ({ entityId: a.entityId, before: a.beforeData, after: a.afterData }))).toEqual([
      { entityId: room.id, before: { validTo: null }, after: { validTo: '2026-11-30' } },
    ])
  }, RACE_TIMEOUT_MS)
})

/** Task 16 fix round (N1): a period date edit cascades to the period's override rows, so it must serialize with retirement (room lock) and with override apply (period lock). */
async function periodState(periodId: string) {
  const [period] = await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.id, periodId))
  const overrides = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.periodId, periodId))
  return { startDate: period!.startDate, endDate: period!.endDate, overrides: overrides.map(o => ({ roomId: o.roomId, validFrom: o.validFrom, validTo: o.validTo })) }
}

describe('retireRoom vs updateCapacityPeriod (date edit) on an overridden room (room-row lock, both acquisition orders)', () => {
  const SPEC = { mode: 'ABSOLUTE' as const, physicalBeds: 6, sellableCapacity: 6 }
  const RETIRE = { effectiveFrom: '2027-08-01' } // last night in inventory 2027-07-31 — allowed while the override ends 07-31
  const EXTEND = { endDate: '2027-08-20' }

  async function setupOverridden() {
    const base = await setup()
    const period = await createCapacityPeriod(base.ctx, base.hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await applyOverrides(base.ctx, base.hotel.id, period.id, { selector: { roomIds: [base.room.id] }, spec: SPEC, onConflict: 'FAIL' })
    return { ...base, period }
  }

  it('the date edit locks the room first (period lock -> room lock): the still-covered extension commits, the waiting retirement re-runs its guard on the committed override -> 409 ROOM_HAS_FUTURE_OVERRIDES; room unchanged, no ROOM_RETIRED audit', async () => {
    const { hotel, hotelScope, ctx, room, period } = await setupOverridden()
    const race = orderRoomLocks('edit', 'retire')

    const [edited, retired] = (await Promise.allSettled([
      race.run('edit', () => updateCapacityPeriod(ctx, hotel.id, period.id, EXTEND)),
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['edit:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(edited!.ok && edited!.value).toMatchObject({ endDate: '2027-08-20', overrideCount: 1 })
    expect(!retired!.ok && retired!.error).toMatchObject({ code: 'ROOM_HAS_FUTURE_OVERRIDES', httpStatus: 409 })

    expect(await periodState(period.id)).toEqual({ startDate: '2027-05-01', endDate: '2027-08-20', overrides: [{ roomId: room.id, validFrom: '2027-05-01', validTo: '2027-08-20' }] })
    const versions = await versionsOf(hotelScope, room.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ validFrom: '2025-01-01', validTo: null })
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'ROOM_RETIRED')).toEqual([])
    expect(audits.filter(a => a.action === 'CAPACITY_PERIOD_UPDATED').map(a => a.entityId)).toEqual([period.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)

  it('the retirement locks the room first: it commits, the waiting date edit re-reads the CLOSED base version -> 409 NOT_IN_INVENTORY_FOR_PERIOD; period and override unchanged, no CAPACITY_PERIOD_UPDATED audit', async () => {
    const { hotel, hotelScope, ctx, room, period } = await setupOverridden()
    const race = orderRoomLocks('retire', 'edit')

    const [edited, retired] = (await Promise.allSettled([
      race.run('edit', () => updateCapacityPeriod(ctx, hotel.id, period.id, EXTEND)),
      race.run('retire', () => retireRoom(ctx, hotel.id, room.id, RETIRE)),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['edit:at-lock', 'retire:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(retired!.ok).toBe(true)
    expect(!edited!.ok && edited!.error).toMatchObject({
      code: 'NOT_IN_INVENTORY_FOR_PERIOD',
      httpStatus: 409,
      details: { conflicts: [{ roomId: room.id, roomNumber: '401', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] },
    })

    expect(await periodState(period.id)).toEqual({ startDate: '2027-05-01', endDate: '2027-07-31', overrides: [{ roomId: room.id, validFrom: '2027-05-01', validTo: '2027-07-31' }] })
    expect(await lastNightOf(hotelScope, room.id)).toBe('2027-07-31')
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'CAPACITY_PERIOD_UPDATED')).toEqual([])
    expect(audits.filter(a => a.action === 'ROOM_RETIRED').map(a => a.entityId)).toEqual([room.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)
})

describe('updateCapacityPeriod vs applyOverrides on the same period (period-row lock, both acquisition orders)', () => {
  const SPEC = { mode: 'ABSOLUTE' as const, physicalBeds: 6, sellableCapacity: 6 }
  const EXTEND = { endDate: '2027-08-20' }

  /** The room's last night is 2027-07-31; the period 05-01..07-31 has NO override yet, so an unserialized date edit would see nothing to validate. */
  async function setupRetiredRoomAndPeriod() {
    const base = await setup()
    await retireRoom(base.ctx, base.hotel.id, base.room.id, { effectiveFrom: '2027-08-01' })
    const period = await createCapacityPeriod(base.ctx, base.hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    return { ...base, period }
  }

  it('the apply locks the period first: its override commits, the waiting date edit then sees it and refuses the extension -> 409 NOT_IN_INVENTORY_FOR_PERIOD; the new override never escapes validation', async () => {
    const { hotel, hotelScope, ctx, room, period } = await setupRetiredRoomAndPeriod()
    const race = orderPeriodLocks('apply', 'edit')

    const [applied, edited] = (await Promise.allSettled([
      race.run('apply', () => applyOverrides(ctx, hotel.id, period.id, { selector: { roomIds: [room.id] }, spec: SPEC, onConflict: 'FAIL' })),
      race.run('edit', () => updateCapacityPeriod(ctx, hotel.id, period.id, EXTEND)),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['apply:at-lock', 'edit:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(applied!.ok && applied!.value).toEqual({ applied: 1, skipped: [] })
    expect(!edited!.ok && edited!.error).toMatchObject({
      code: 'NOT_IN_INVENTORY_FOR_PERIOD',
      httpStatus: 409,
      details: { conflicts: [{ roomId: room.id, roomNumber: '401', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] },
    })

    expect(await periodState(period.id)).toEqual({ startDate: '2027-05-01', endDate: '2027-07-31', overrides: [{ roomId: room.id, validFrom: '2027-05-01', validTo: '2027-07-31' }] })
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'CAPACITY_PERIOD_UPDATED')).toEqual([])
    expect(audits.filter(a => a.action === 'CAPACITY_OVERRIDES_APPLIED').map(a => a.entityId)).toEqual([period.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)

  it('the date edit locks the period first: the extension (no overrides yet) commits, the waiting apply re-reads the EXTENDED period -> 409 OVERRIDE_CONFLICT (NOT_IN_INVENTORY_FOR_PERIOD); no override row, no CAPACITY_OVERRIDES_APPLIED audit', async () => {
    const { hotel, hotelScope, ctx, room, period } = await setupRetiredRoomAndPeriod()
    const race = orderPeriodLocks('edit', 'apply')

    const [applied, edited] = (await Promise.allSettled([
      race.run('apply', () => applyOverrides(ctx, hotel.id, period.id, { selector: { roomIds: [room.id] }, spec: SPEC, onConflict: 'FAIL' })),
      race.run('edit', () => updateCapacityPeriod(ctx, hotel.id, period.id, EXTEND)),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(0, 2).sort()).toEqual(['apply:at-lock', 'edit:at-lock'])
    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(edited!.ok && edited!.value).toMatchObject({ endDate: '2027-08-20', overrideCount: 0 })
    expect(!applied!.ok && applied!.error).toMatchObject({ code: 'OVERRIDE_CONFLICT', httpStatus: 409, details: { skipped: [{ roomId: room.id, roomNumber: '401', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] } })

    expect(await periodState(period.id)).toEqual({ startDate: '2027-05-01', endDate: '2027-08-20', overrides: [] })
    const audits = await auditActions(hotel.id)
    expect(audits.filter(a => a.action === 'CAPACITY_OVERRIDES_APPLIED')).toEqual([])
    expect(audits.filter(a => a.action === 'CAPACITY_PERIOD_UPDATED').map(a => a.entityId)).toEqual([period.id])
    await expectNothingPastRetirement(hotelScope, room.id)
  }, RACE_TIMEOUT_MS)
})

describe('same-room writers serialize on the room lock too', () => {
  it('two concurrent same-kind overlapping creates: the second waits for the first and gets the friendly 409 BLOCK_OVERLAP; one row, one audit row', async () => {
    const { hotel, ctx, room } = await setup()
    const race = orderRoomLocks('A', 'B')

    const [a, b] = (await Promise.allSettled([
      race.run('A', () => createRoomBlock(ctx, hotel.id, room.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'A' })),
      race.run('B', () => createRoomBlock(ctx, hotel.id, room.id, { kind: 'MAINTENANCE', startDate: '2026-10-05', endDate: '2026-10-15', reason: 'B' })),
    ])).map(settledOutcome)
    vi.restoreAllMocks()

    expect(race.events.slice(2)).toEqual(race.expectedEvents())
    expect(a!.ok).toBe(true)
    expect(!b!.ok && b!.error).toMatchObject({ code: 'BLOCK_OVERLAP', httpStatus: 409 })
    const rows = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, room.id))
    expect(rows.map(r => r.reason)).toEqual(['A'])
    expect((await auditActions(hotel.id)).filter(x => x.action === 'BLOCK_CREATED').map(x => x.entityId)).toEqual([rows[0]!.id])
  }, RACE_TIMEOUT_MS)

  it('two bulk creates over the same rooms given in OPPOSITE order, released together, both succeed: lockByIds takes the locks in ascending-id order, so they never deadlock', async () => {
    const { hotel, floor, roomType, ctx, room } = await setup()
    const other = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: '2025-01-01', features: [] })
    for (let attempt = 0; attempt < 3; attempt++) {
      const realLockByIds = RoomRepository.prototype.lockByIds
      let arrived = 0
      let release!: () => void
      const bothReady = new Promise<void>((resolve) => { release = resolve })
      const spy = vi.spyOn(RoomRepository.prototype, 'lockByIds').mockImplementation(async function (this: RoomRepository, ...args) {
        if (++arrived === 2) release()
        await withTimeout(bothReady, 'both bulk creates to reach lockByIds')
        return realLockByIds.apply(this, args)
      })
      const start = `2026-1${attempt}-01`
      const end = `2026-1${attempt}-05`
      const results = await Promise.allSettled([
        bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: start, endDate: end, reason: 'M', roomIds: [room.id, other.id] }),
        bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OUT_OF_SERVICE', startDate: start, endDate: end, reason: 'O', roomIds: [other.id, room.id] }),
      ])
      spy.mockRestore()
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    }
    expect(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.hotelId, hotel.id))).toHaveLength(12)
  }, RACE_TIMEOUT_MS)
})

describe('the room lock preserves scoping (a foreign room is neither returned nor locked)', () => {
  /** Tries to lock the room from ANOTHER connection without waiting: true when the row is free, false when someone holds it (55P03). */
  async function rowIsFree(roomId: string): Promise<boolean> {
    try {
      await getTestClient().begin(async sql => sql`SELECT id FROM room WHERE id = ${roomId} FOR UPDATE NOWAIT`)
      return true
    }
    catch (error) {
      if ((error as { code?: string }).code === '55P03') return false
      throw error
    }
  }

  it('findById({ forUpdate }) and lockByIds under another hotel (same org) or another org return nothing and leave the row unlocked; under the right scope they lock it', async () => {
    const { scope, hotelScope, room } = await setup()
    const otherHotel = await makeHotel(db, scope, { timezone: 'UTC' })
    const { scope: otherOrg } = await makeOrg(db)
    const otherOrgHotel = await makeHotel(db, otherOrg, { timezone: 'UTC' })

    for (const foreignScope of [trustedHotelScope(scope, otherHotel.id), trustedHotelScope(otherOrg, otherOrgHotel.id)]) {
      await db.transaction(async (tx) => {
        const repo = new RoomRepository(tx, foreignScope)
        expect(await repo.findById(room.id, { forUpdate: true })).toBeNull()
        expect(await repo.lockByIds([room.id])).toEqual([])
        expect(await rowIsFree(room.id)).toBe(true)
      })
    }

    // Positive control: the right scope really takes the lock (another connection cannot get it), single and multi-room.
    await db.transaction(async (tx) => {
      expect((await new RoomRepository(tx, hotelScope).findById(room.id, { forUpdate: true }))?.id).toBe(room.id)
      expect(await rowIsFree(room.id)).toBe(false)
    })
    await db.transaction(async (tx) => {
      expect((await new RoomRepository(tx, hotelScope).lockByIds([room.id, room.id])).map(r => r.id)).toEqual([room.id])
      expect(await rowIsFree(room.id)).toBe(false)
    })
    expect(await rowIsFree(room.id)).toBe(true)
  })

  it('CapacityPeriodRepository.findById({ forUpdate }) under another hotel or another org returns nothing and leaves the period row unlocked; under the right scope it locks it', async () => {
    const { scope, hotelScope, ctx, hotel } = await setup()
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Lock Scope', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const otherHotel = await makeHotel(db, scope, { timezone: 'UTC' })
    const { scope: otherOrg } = await makeOrg(db)
    const otherOrgHotel = await makeHotel(db, otherOrg, { timezone: 'UTC' })
    async function periodRowIsFree(): Promise<boolean> {
      try {
        await getTestClient().begin(async sql => sql`SELECT id FROM capacity_period WHERE id = ${period.id} FOR UPDATE NOWAIT`)
        return true
      }
      catch (error) {
        if ((error as { code?: string }).code === '55P03') return false
        throw error
      }
    }

    for (const foreignScope of [trustedHotelScope(scope, otherHotel.id), trustedHotelScope(otherOrg, otherOrgHotel.id)]) {
      await db.transaction(async (tx) => {
        expect(await new CapacityPeriodRepository(tx, foreignScope).findById(period.id, { forUpdate: true })).toBeNull()
        expect(await periodRowIsFree()).toBe(true)
      })
    }
    await db.transaction(async (tx) => {
      expect((await new CapacityPeriodRepository(tx, hotelScope).findById(period.id, { forUpdate: true }))?.id).toBe(period.id)
      expect(await periodRowIsFree()).toBe(false)
    })
    expect(await periodRowIsFree()).toBe(true)
  })

  it('lockByIds de-duplicates, returns rows in ascending id order, and an empty list issues no query', async () => {
    const { hotel, hotelScope, floor, roomType, ctx, room } = await setup()
    const more = await Promise.all(['402', '403', '404'].map(n => createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: n, inServiceFrom: '2025-01-01', features: [] })))
    const ids = [more[2]!.id, room.id, more[0]!.id, room.id, more[1]!.id]
    await db.transaction(async (tx) => {
      const rows = await new RoomRepository(tx, hotelScope).lockByIds(ids)
      expect(rows.map(r => r.id)).toEqual([...new Set(ids)].sort())
      expect(await new RoomRepository(tx, hotelScope).lockByIds([])).toEqual([])
    })
  })
})
