import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog, capacityPeriod as capacityPeriodTable } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { ForbiddenError, NotFoundError } from '../../../server/errors/domainError'
import { AuditRepository, RoomTypeRepository } from '../../../server/repositories/tenant'
import { CapacityPeriodRepository, FloorRepository, RoomBaseConfigRepository, RoomCapacityOverrideRepository, RoomRepository } from '../../../server/repositories/hotel'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import type { Permission } from '../../../shared/constants/permissions'
import { MAX_OVERRIDE_SELECTOR_ROOMS } from '../../../shared/constants/inventory'
import { applyOverridesSchema, overrideSelectorSchema, removeOverridesSchema } from '../../../shared/schemas/capacityPeriod'
import {
  applyOverrides,
  createCapacityPeriod,
  deleteCapacityPeriod,
  deleteOverride,
  getCapacityPeriod,
  getRoomCapacityTimeline,
  listCapacityPeriods,
  listOverrides,
  previewOverrides,
  removeOverrides,
  updateCapacityPeriod,
} from '../../../server/services/capacityPeriodService'
import { changeBaseConfig, createRoom, getRoom, listRooms, retireRoom } from '../../../server/services/roomService'
import { makeFloor, makeHotel, makeOrg, makeRoomType } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  vi.restoreAllMocks()
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function makeCtx(scope: OrganizationScope, opts: {
  userId?: string
  permissions?: Permission[]
  allHotels?: boolean
  hotelIds?: string[]
  now?: () => Date
} = {}): AuthContext {
  return {
    identity: { userId: opts.userId ?? '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'caller@test.com', fullName: 'Caller' },
    authz: {
      permissions: new Set(opts.permissions ?? []),
      allHotels: opts.allHotels ?? false,
      hotelIds: new Set(opts.hotelIds ?? []),
    },
    scope,
    db: db as Database,
    now: opts.now ?? (() => new Date()),
  }
}

const CLOCK = () => new Date('2026-09-25T12:00:00Z') // hotel-local "today" = 2026-09-25 for UTC hotels

async function setupHotel(scope: OrganizationScope) {
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
  const roomType = await makeRoomType(db, scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  return { hotel, floor, roomType }
}

function fullCtx(scope: OrganizationScope, hotelId: string, now: () => Date = CLOCK) {
  return makeCtx(scope, { permissions: ['room.view', 'room.manage', 'capacity.manage'], hotelIds: [hotelId], now })
}

/**
 * Calls `applyOverrides` with `onConflict: 'FAIL'` defaulted — service-level tests bypass the zod
 * schema (which applies this default during HTTP parsing), so it must be supplied explicitly here.
 */
function apply(ctx: AuthContext, hotelId: string, periodId: string, input: Omit<Parameters<typeof applyOverrides>[3], 'onConflict'> & { onConflict?: 'FAIL' | 'SKIP' }) {
  return applyOverrides(ctx, hotelId, periodId, { onConflict: 'FAIL', ...input })
}

function preview(ctx: AuthContext, hotelId: string, periodId: string, input: Omit<Parameters<typeof previewOverrides>[3], 'onConflict'> & { onConflict?: 'FAIL' | 'SKIP' }) {
  return previewOverrides(ctx, hotelId, periodId, { onConflict: 'FAIL', ...input })
}

/** Room 401: Quad 4/4, in service since 2025-01-01 — the requirement worked example's room. */
async function makeRoom401(ctx: AuthContext, scope: OrganizationScope, hotel: { id: string }, floor: { id: string }, roomType: { id: string }) {
  return createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: '2025-01-01', physicalBeds: 4, sellableCapacity: 4, features: [] })
}

describe('the requirement worked example: Room 401, Hajj 2027, ABSOLUTE 6/6 (test group 2)', () => {
  it('base version rows stay unchanged; the timeline shows BASE / PERIOD_OVERRIDE / BASE around the season', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)

    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const result = await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, reason: 'Hajj surge' })
    expect(result).toEqual({ applied: 1, skipped: [] })

    const timeline = await getRoomCapacityTimeline(ctx, hotel.id, room401.id, { from: '2027-01-01', to: '2027-12-31' })
    const bySource = timeline.segments.map(s => ({ from: s.from, to: s.to, physicalBeds: s.physicalBeds, sellableCapacity: s.sellableCapacity, source: s.source }))
    expect(bySource).toEqual([
      { from: '2027-01-01', to: '2027-04-30', physicalBeds: 4, sellableCapacity: 4, source: 'BASE' },
      { from: '2027-05-01', to: '2027-07-31', physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE' },
      { from: '2027-08-01', to: '2027-12-31', physicalBeds: 4, sellableCapacity: 4, source: 'BASE' },
    ])
    expect(Object.keys(timeline.refs.periods)).toEqual([period.id])

    // Base version rows: exactly the ORIGINAL single open-ended version, untouched.
    const versions = await new RoomBaseConfigRepository(db, trustedHotelScope(scope, hotel.id)).versionsForRoom(room401.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4 })
  })
})

describe('boundaries (test group 3)', () => {
  it('effective capacity on 04-30, 05-01, 07-31, 08-01', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    const roomAt = async (date: string) => listRooms(ctx, hotel.id, { asOf: date, page: 1, pageSize: 20 }).then(p => p.items.find(i => i.id === room401.id)!)

    expect((await roomAt('2027-04-30')).effective).toMatchObject({ physicalBeds: 4, sellableCapacity: 4, source: 'BASE' })
    expect((await roomAt('2027-05-01')).effective).toMatchObject({ physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE' })
    expect((await roomAt('2027-05-01')).effective?.period?.id).toBe(period.id)
    expect((await roomAt('2027-07-31')).effective).toMatchObject({ physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE' })
    expect((await roomAt('2027-08-01')).effective).toMatchObject({ physicalBeds: 4, sellableCapacity: 4, source: 'BASE' })
  })

  it('adjacent periods (…-07-31 and 08-01…) both overriding the same room succeed', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const periodA = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const periodB = await createCapacityPeriod(ctx, hotel.id, { name: 'Post-Hajj 2027', kind: 'SPECIAL', startDate: '2027-08-01', endDate: '2027-08-31' })

    await expect(apply(ctx, hotel.id, periodA.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })).resolves.toEqual({ applied: 1, skipped: [] })
    await expect(apply(ctx, hotel.id, periodB.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 } })).resolves.toEqual({ applied: 1, skipped: [] })
  })

  it('an overlapping period (07-15…) for a room that already has the earlier override -> service-level 409 (pre-check), nothing written', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const periodA = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const periodC = await createCapacityPeriod(ctx, hotel.id, { name: 'Overlap', kind: 'SPECIAL', startDate: '2027-07-15', endDate: '2027-09-15' })
    await apply(ctx, hotel.id, periodA.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    await expect(apply(ctx, hotel.id, periodC.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 }, onConflict: 'FAIL' }))
      .rejects.toMatchObject({ code: 'OVERRIDE_CONFLICT', httpStatus: 409, details: { skipped: [{ roomId: room401.id, reason: 'ALREADY_OVERRIDDEN' }] } })

    const overrides = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(periodC.id)
    expect(overrides).toEqual([])
  })

  it('a leap-day period 2028-02-01..2028-03-01 includes 02-29', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Leap', kind: 'SPECIAL', startDate: '2028-02-01', endDate: '2028-03-01' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 } })

    const timeline = await getRoomCapacityTimeline(ctx, hotel.id, room401.id, { from: '2028-01-25', to: '2028-03-05' })
    expect(timeline.segments).toEqual([
      { from: '2028-01-25', to: '2028-01-31', physicalBeds: 4, sellableCapacity: 4, source: 'BASE', periodId: null },
      { from: '2028-02-01', to: '2028-03-01', physicalBeds: 5, sellableCapacity: 5, source: 'PERIOD_OVERRIDE', periodId: period.id },
      { from: '2028-03-02', to: '2028-03-05', physicalBeds: 4, sellableCapacity: 4, source: 'BASE', periodId: null },
    ])
    // 02-29 (the leap day itself) falls inside the single override segment above, proving it is included.
    const leapDaySegment = timeline.segments.find(s => s.from <= '2028-02-29' && s.to >= '2028-02-29')
    expect(leapDaySegment?.source).toBe('PERIOD_OVERRIDE')
  })

  it('a 366-day period succeeds; 367 days -> 422 PERIOD_TOO_LONG', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    await expect(createCapacityPeriod(ctx, hotel.id, { name: 'Long 366', kind: 'SPECIAL', startDate: '2028-01-01', endDate: '2028-12-31' })).resolves.toBeDefined()
    await expect(createCapacityPeriod(ctx, hotel.id, { name: 'Long 367', kind: 'SPECIAL', startDate: '2028-01-01', endDate: '2029-01-01' }))
      .rejects.toMatchObject({ code: 'PERIOD_TOO_LONG', httpStatus: 422 })
  })
})

describe('history (test group 4)', () => {
  it('an ended period stays queryable (includePast=true); timeline over past dates resolves against overrides actually in force', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const beforeCtx = fullCtx(scope, hotel.id, () => new Date('2027-01-01T12:00:00Z')) // "today" BEFORE the period starts, so the override can still be applied
    const room401 = await makeRoom401(beforeCtx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(beforeCtx, hotel.id, { name: 'Hajj 2027 Ended', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(beforeCtx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    const ctx = fullCtx(scope, hotel.id, () => new Date('2027-09-01T12:00:00Z')) // "today" NOW after the period ended -- for the history queries below

    const excluded = await listCapacityPeriods(ctx, hotel.id, { includePast: false })
    expect(excluded.find(p => p.id === period.id)).toBeUndefined()

    const included = await listCapacityPeriods(ctx, hotel.id, { includePast: true })
    const dto = included.find(p => p.id === period.id)!
    expect(dto.phase).toBe('ENDED')

    const timeline = await getRoomCapacityTimeline(ctx, hotel.id, room401.id, { from: '2027-06-01', to: '2027-06-30' })
    expect(timeline.segments).toEqual([{ from: '2027-06-01', to: '2027-06-30', physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE', periodId: period.id }])
  })

  it('editing an ENDED period\'s dates -> 409 PERIOD_ENDED; renaming and notes -> 200', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id, () => new Date('2027-09-01T12:00:00Z'))
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027 Edit', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-08-15' })).rejects.toMatchObject({ code: 'PERIOD_ENDED', httpStatus: 409 })
    const renamed = await updateCapacityPeriod(ctx, hotel.id, period.id, { name: 'Hajj 1448', notes: 'archived' })
    expect(renamed.name).toBe('Hajj 1448')
    expect(renamed.notes).toBe('archived')
  })
})

describe('running-period rules (test group 5, injected clock)', () => {
  const NOW = () => new Date('2027-06-15T12:00:00Z') // "today" = 2027-06-15, inside 2027-05-01..07-31

  it('an ACTIVE period may shorten its end to yesterday', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id, NOW)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj Running A', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const updated = await updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-06-14' })
    expect(updated.endDate).toBe('2027-06-14')
  })

  it('cutting the end further into the past (before yesterday) -> 409 PERIOD_END_IN_PAST', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id, NOW)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj Running B', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-06-01' })).rejects.toMatchObject({ code: 'PERIOD_END_IN_PAST', httpStatus: 409 })
  })

  it('start/kind cannot change while running -> 409 PERIOD_STARTED', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id, NOW)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj Running C', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { startDate: '2027-05-02' })).rejects.toMatchObject({ code: 'PERIOD_STARTED', httpStatus: 409 })
    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { kind: 'SPECIAL' })).rejects.toMatchObject({ code: 'PERIOD_STARTED', httpStatus: 409 })
  })

  it('adding overrides to a running period -> 409 PERIOD_STARTED', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id, NOW)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj Running D', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await expect(apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } }))
      .rejects.toMatchObject({ code: 'PERIOD_STARTED', httpStatus: 409 })
  })

  it('deleting a running period -> 409 PERIOD_STARTED', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id, NOW)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj Running E', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await expect(deleteCapacityPeriod(ctx, hotel.id, period.id)).rejects.toMatchObject({ code: 'PERIOD_STARTED', httpStatus: 409 })
  })
})

describe('selectors (test group 6)', () => {
  it('{ floorIds: [] } -> 422; {} -> 422; two selector kinds together -> 422', async () => {
    const { scope } = await makeOrg(db)
    const { floor, roomType } = await setupHotel(scope)

    expect(overrideSelectorSchema.safeParse({ floorIds: [] }).success).toBe(false)
    expect(overrideSelectorSchema.safeParse({}).success).toBe(false)
    expect(overrideSelectorSchema.safeParse({ floorIds: [floor.id], roomTypeIds: [roomType.id] }).success).toBe(false)
  })

  it('{ all: true } applies to every room in inventory', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    await makeRoom401(ctx, scope, hotel, floor, roomType)
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: '2025-01-01', features: [] })
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'All Rooms', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const result = await apply(ctx, hotel.id, period.id, { selector: { all: true }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    expect(result.applied).toBe(2)
  })

  it('a floorId of another hotel (same org) -> 422 INVALID_REFERENCE', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const { floor: otherFloor } = await setupHotel(scope) // a different hotel
    const ctx = fullCtx(scope, hotel.id)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Foreign Floor', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    await expect(apply(ctx, hotel.id, period.id, { selector: { floorIds: [otherFloor.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
  })

  it('duplicate roomIds are deduplicated before applying', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Dup Ids', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const parsed = applyOverridesSchema.parse({ selector: { roomIds: [room401.id, room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    expect(parsed.selector).toEqual({ roomIds: [room401.id] })
    const result = await apply(ctx, hotel.id, period.id, parsed)
    expect(result.applied).toBe(1)
  })

  it('roomTypeIds selects by type', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const otherType = await makeRoomType(db, scope, { defaultPhysicalBeds: 2, defaultSellableCapacity: 2 })
    const ctx = fullCtx(scope, hotel.id)
    const roomA = await makeRoom401(ctx, scope, hotel, floor, roomType)
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: otherType.id, roomNumber: '999', inServiceFrom: '2025-01-01', features: [] })
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'By Type', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const result = await apply(ctx, hotel.id, period.id, { selector: { roomTypeIds: [roomType.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    expect(result.applied).toBe(1)
    const overrides = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)
    expect(overrides.map(o => o.roomId)).toEqual([roomA.id])
  })

  it('floorIds / roomTypeIds are validated in ONE batched query each (never one per id); one foreign id among valid ones -> 422 INVALID_REFERENCE; duplicates from a direct caller are fine', async () => {
    const { scope } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const { floor: otherHotelFloor } = await setupHotel(scope) // same org, other hotel
    const foreignType = await makeRoomType(db, otherOrg)
    const secondFloor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
    const ctx = fullCtx(scope, hotel.id)
    await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Batched Selector', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const spec = { mode: 'ABSOLUTE' as const, physicalBeds: 6, sellableCapacity: 6 }

    const floorFindById = vi.spyOn(FloorRepository.prototype, 'findById')
    const floorFindByIds = vi.spyOn(FloorRepository.prototype, 'findByIds')
    const typeFindById = vi.spyOn(RoomTypeRepository.prototype, 'findById')
    const typeFindByIds = vi.spyOn(RoomTypeRepository.prototype, 'findByIds')

    await expect(preview(ctx, hotel.id, period.id, { selector: { floorIds: [floor.id, secondFloor.id, otherHotelFloor.id] }, spec }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
    await expect(apply(ctx, hotel.id, period.id, { selector: { roomTypeIds: [roomType.id, foreignType.id] }, spec }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
    expect(floorFindByIds).toHaveBeenCalledTimes(1)
    expect(typeFindByIds).toHaveBeenCalledTimes(1)
    expect(floorFindById).not.toHaveBeenCalled()
    expect(typeFindById).not.toHaveBeenCalled()

    await expect(preview(ctx, hotel.id, period.id, { selector: { floorIds: [floor.id, secondFloor.id, floor.id] }, spec })).resolves.toMatchObject({ totals: { rooms: 1 } })
    await expect(apply(ctx, hotel.id, period.id, { selector: { roomTypeIds: [roomType.id, roomType.id] }, spec })).resolves.toEqual({ applied: 1, skipped: [] })
  })
})

describe('DELTA mode uses base at period start (test group 7)', () => {
  it('a room whose base changes MID-PERIOD still shows the frozen, period-start-based override result', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType) // base 4/4, open-ended from 2025-01-01
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Delta Period', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const applied = await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'DELTA', deltaBeds: 2, deltaSellable: 1 } })
    expect(applied.applied).toBe(1)
    const overrides = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)
    // 4+2=6 beds, 4+1=5 sellable -- base AT PERIOD START (2027-05-01), which was 4/4.
    expect(overrides[0]).toMatchObject({ physicalBeds: 6, sellableCapacity: 5 })

    // A LATER, independent base-config change takes effect mid-period -- must NOT retroactively affect the already-applied override.
    await changeBaseConfig(ctx, hotel.id, room401.id, { effectiveFrom: '2027-06-01', physicalBeds: 10, sellableCapacity: 10 })

    const timeline = await getRoomCapacityTimeline(ctx, hotel.id, room401.id, { from: '2027-06-01', to: '2027-06-15' })
    expect(timeline.segments).toEqual([{ from: '2027-06-01', to: '2027-06-15', physicalBeds: 6, sellableCapacity: 5, source: 'PERIOD_OVERRIDE', periodId: period.id }])
  })

  it('a DELTA producing an out-of-range result -> 422 OVERRIDE_OUT_OF_RANGE, nothing written', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Delta OOR', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    await expect(apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'DELTA', deltaBeds: -10, deltaSellable: 0 } }))
      .rejects.toMatchObject({ code: 'OVERRIDE_OUT_OF_RANGE', httpStatus: 422 })
    const overrides = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)
    expect(overrides).toEqual([])
  })
})

describe('FAIL vs SKIP (test group 8)', () => {
  it('a room commissioned mid-period and a room retired mid-period are NOT_IN_INVENTORY_FOR_PERIOD; a room already overridden by an overlapping period is ALREADY_OVERRIDDEN', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const commissionedMidPeriod = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: '2027-06-01', features: [] })
    const alreadyOverriddenRoom = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const retiringRoom = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '403', inServiceFrom: '2025-01-01', features: [] })
    await retireRoom(ctx, hotel.id, retiringRoom.id, { effectiveFrom: '2027-06-15' }) // leaves inventory mid-period

    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Skip Period', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const earlierPeriod = await createCapacityPeriod(ctx, hotel.id, { name: 'Earlier Overlap', kind: 'SPECIAL', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(ctx, hotel.id, earlierPeriod.id, { selector: { roomIds: [alreadyOverriddenRoom.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    const result = await apply(ctx, hotel.id, period.id, {
      selector: { roomIds: [commissionedMidPeriod.id, retiringRoom.id, alreadyOverriddenRoom.id] },
      spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 },
      onConflict: 'SKIP',
    })
    expect(result.applied).toBe(0)
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ roomId: commissionedMidPeriod.id, reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }),
      expect.objectContaining({ roomId: retiringRoom.id, reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }),
      expect.objectContaining({ roomId: alreadyOverriddenRoom.id, reason: 'ALREADY_OVERRIDDEN' }),
    ]))
  })

  it('FAIL writes nothing when anything is skipped; SKIP writes the rest and reports skips', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const goodRoom = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const lateRoom = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '404', inServiceFrom: '2027-06-01', features: [] })
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Fail Vs Skip', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    await expect(apply(ctx, hotel.id, period.id, { selector: { roomIds: [goodRoom.id, lateRoom.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, onConflict: 'FAIL' }))
      .rejects.toMatchObject({ code: 'OVERRIDE_CONFLICT', httpStatus: 409 })
    expect(await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)).toEqual([])

    const result = await apply(ctx, hotel.id, period.id, { selector: { roomIds: [goodRoom.id, lateRoom.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, onConflict: 'SKIP' })
    expect(result.applied).toBe(1)
    expect(result.skipped).toEqual([{ roomId: lateRoom.id, roomNumber: '404', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }])
    const overrides = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)
    expect(overrides.map(o => o.roomId)).toEqual([goodRoom.id])
  })
})

/**
 * Task 16 fix round: `applyOverrides` now row-locks its rooms before planning (proved in
 * roomInventoryLocking.test.ts), so two applies on one room serialize and the second sees the first's
 * override (ALREADY_OVERRIDDEN). The database exclusion constraint stays the backstop for any writer
 * that does NOT take that lock (e.g. a period date edit cascading into override rows) — the races
 * below bypass the lock (same scoped read, no FOR UPDATE) to keep proving that backstop.
 */
function bypassRoomLock() {
  vi.spyOn(RoomRepository.prototype, 'lockByIds').mockImplementation(function (this: RoomRepository, ids: readonly string[]) {
    return this.findByIds(ids)
  })
}

describe('concurrency (test group 10, real PostgreSQL)', () => {
  it('two simultaneous applications of overlapping periods to the same room (room lock bypassed): exactly one override lands, the other 409s (real-error translation: room_override_no_overlap -> RANGE_OVERLAP), whole-transaction atomicity', async () => {
    bypassRoomLock()
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctxA = fullCtx(scope, hotel.id)
    const ctxB = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctxA, scope, hotel, floor, roomType)
    const periodA = await createCapacityPeriod(ctxA, hotel.id, { name: 'Concurrent A', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const periodB = await createCapacityPeriod(ctxA, hotel.id, { name: 'Concurrent B', kind: 'SPECIAL', startDate: '2027-06-01', endDate: '2027-06-30' }) // overlaps periodA's range

    // Deterministic race: each transaction runs the REAL `findOverlapping` pre-check, then waits until
    // BOTH have finished it before either inserts — so both pre-checks provably saw no conflict, and
    // only the database exclusion constraint can stop the second insert (without this barrier the
    // first transaction may commit before the second's pre-check, which then 409s on the pre-check
    // instead and proves nothing about the DB arbiter).
    const realFindOverlapping = RoomCapacityOverrideRepository.prototype.findOverlapping
    let arrived = 0
    let releaseBarrier!: () => void
    const bothPreChecked = new Promise<void>((resolve) => { releaseBarrier = resolve })
    const preCheckSpy = vi.spyOn(RoomCapacityOverrideRepository.prototype, 'findOverlapping').mockImplementation(async function (this: RoomCapacityOverrideRepository, ...args) {
      const rows = await realFindOverlapping.apply(this, args)
      if (++arrived === 2) releaseBarrier()
      await bothPreChecked
      return rows
    })

    const results = await Promise.allSettled([
      apply(ctxA, hotel.id, periodA.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } }),
      apply(ctxB, hotel.id, periodB.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 } }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The loser's pre-check (findOverlapping, run before either has committed) sees no conflict -- it
    // is the DATABASE exclusion constraint that catches the race and is translated to this 409.
    expect(rejected[0]!.reason).toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
    expect(preCheckSpy).toHaveBeenCalledTimes(2)
    preCheckSpy.mockRestore()

    // Exactly one override survives, and it is the WINNER's; the loser's period has no rows at all.
    const winnerPeriodId = results[0]!.status === 'fulfilled' ? periodA.id : periodB.id
    const loserPeriodId = winnerPeriodId === periodA.id ? periodB.id : periodA.id
    const overrideRepo = new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id))
    const overrides = await overrideRepo.findByRoomIds([room401.id], { from: '2027-01-01', to: '2027-12-31' })
    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.periodId).toBe(winnerPeriodId)
    expect(await overrideRepo.findByPeriod(loserPeriodId)).toEqual([])

    // The loser's audit row rolled back with it: exactly one CAPACITY_OVERRIDES_APPLIED row, the winner's.
    const applyAudits = await db.select().from(auditLog).where(and(eq(auditLog.hotelId, hotel.id), eq(auditLog.action, 'CAPACITY_OVERRIDES_APPLIED')))
    expect(applyAudits.map(a => a.entityId)).toEqual([winnerPeriodId])
  })

  it('INSERTs fired at the same instant (room lock bypassed): the loser still gets 409 RANGE_OVERLAP (PostgreSQL resolves this race with 23P01 or a 40P01 deadlock), exactly one override and one audit row', async () => {
    bypassRoomLock()
    // Reproduced on PostgreSQL 16: when both conflicting inserts reach the exclusion check together,
    // each waits on the other's in-progress row and PostgreSQL aborts one with 40P01 (deadlock), not
    // 23P01. Repeated a few times so the deadlock path is exercised in practice; the outcome must be
    // identical either way.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { scope } = await makeOrg(db)
      const { hotel, floor, roomType } = await setupHotel(scope)
      const ctx = fullCtx(scope, hotel.id)
      const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
      const periodA = await createCapacityPeriod(ctx, hotel.id, { name: 'Simultaneous A', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
      const periodB = await createCapacityPeriod(ctx, hotel.id, { name: 'Simultaneous B', kind: 'SPECIAL', startDate: '2027-06-01', endDate: '2027-06-30' })

      const realInsertMany = RoomCapacityOverrideRepository.prototype.insertMany
      let arrived = 0
      let releaseBarrier!: () => void
      const bothReady = new Promise<void>((resolve) => { releaseBarrier = resolve })
      const insertSpy = vi.spyOn(RoomCapacityOverrideRepository.prototype, 'insertMany').mockImplementation(async function (this: RoomCapacityOverrideRepository, ...args) {
        if (++arrived === 2) releaseBarrier()
        await bothReady
        return realInsertMany.apply(this, args)
      })

      const results = await Promise.allSettled([
        apply(ctx, hotel.id, periodA.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } }),
        apply(ctx, hotel.id, periodB.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 } }),
      ])
      insertSpy.mockRestore()

      const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason).toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
      const winnerPeriodId = results[0]!.status === 'fulfilled' ? periodA.id : periodB.id
      const overrides = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByRoomIds([room401.id], { from: '2027-01-01', to: '2027-12-31' })
      expect(overrides.map(o => o.periodId)).toEqual([winnerPeriodId])
      const applyAudits = await db.select().from(auditLog).where(and(eq(auditLog.hotelId, hotel.id), eq(auditLog.action, 'CAPACITY_OVERRIDES_APPLIED')))
      expect(applyAudits.map(a => a.entityId)).toEqual([winnerPeriodId])
    }
  })

  it('a 40P01 deadlock raised by the override insert is translated to 409 RANGE_OVERLAP and the transaction rolls back (deterministic)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Deadlock', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const deadlock = Object.assign(new Error('Failed query: insert into "room_capacity_override"'), { cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }) })
    vi.spyOn(RoomCapacityOverrideRepository.prototype, 'insertMany').mockRejectedValue(deadlock)
    await expect(apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } }))
      .rejects.toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, period.id), eq(auditLog.action, 'CAPACITY_OVERRIDES_APPLIED')))).toEqual([])
  })
})

describe('authorization (test group 11)', () => {
  it('room.view-only user can GET but 403 on POST', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const viewer = makeCtx(scope, { permissions: ['room.view'], hotelIds: [hotel.id], now: CLOCK })

    await expect(listCapacityPeriods(viewer, hotel.id, { includePast: false })).resolves.toEqual([])
    await expect(createCapacityPeriod(viewer, hotel.id, { name: 'Forbidden', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('a hotel-scoped user of hotel A gets 404 on hotel B', async () => {
    const { scope } = await makeOrg(db)
    const { hotel: hotelA } = await setupHotel(scope)
    const { hotel: hotelB } = await setupHotel(scope)
    const ctxA = makeCtx(scope, { permissions: ['room.view', 'capacity.manage'], hotelIds: [hotelA.id], now: CLOCK })

    await expect(listCapacityPeriods(ctxA, hotelB.id, { includePast: false })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('a periodId/roomId from another hotel of the same org -> 404; from another org -> the same 404 shape', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const { hotel: hotelA } = await setupHotel(orgA)
    const { hotel: hotelB, floor: floorB, roomType: typeB } = await setupHotel(orgA)
    const { hotel: hotelC, floor: floorC, roomType: typeC } = await setupHotel(orgB)

    const ctxAll = makeCtx(orgA, { permissions: ['room.view', 'room.manage', 'capacity.manage'], hotelIds: [hotelA.id, hotelB.id], now: CLOCK })
    const roomInB = await createRoom(ctxAll, hotelB.id, { floorId: floorB.id, roomTypeId: typeB.id, roomNumber: '501', inServiceFrom: '2025-01-01', features: [] })
    const periodInB = await createCapacityPeriod(ctxAll, hotelB.id, { name: 'In Hotel B', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const ctxC = fullCtx(orgB, hotelC.id)
    await createRoom(ctxC, hotelC.id, { floorId: floorC.id, roomTypeId: typeC.id, roomNumber: '502', inServiceFrom: '2025-01-01', features: [] })
    const periodInC = await createCapacityPeriod(ctxC, hotelC.id, { name: 'In Hotel C', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    // hotel A's caller trying hotel B's ids under hotel A's URL -> 404
    const sameOrgErr = await getCapacityPeriod(ctxAll, hotelA.id, periodInB.id).catch(e => e)
    expect(sameOrgErr).toBeInstanceOf(NotFoundError)
    const sameOrgRoomErr = await getRoomCapacityTimeline(ctxAll, hotelA.id, roomInB.id, { from: '2027-01-01', to: '2027-01-02' }).catch(e => e)
    expect(sameOrgRoomErr).toBeInstanceOf(NotFoundError)

    // org A's caller trying org B's (hotel C) ids entirely -> the SAME 404 shape
    const foreignOrgErr = await getCapacityPeriod(ctxAll, hotelA.id, periodInC.id).catch(e => e)
    expect(foreignOrgErr).toBeInstanceOf(NotFoundError)
    expect(foreignOrgErr.code).toBe(sameOrgErr.code)
  })
})

describe('retire guard (test group 12)', () => {
  it('retiring a room with a future override -> 409 ROOM_HAS_FUTURE_OVERRIDES; after deleting the override -> 200', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Retire Guard', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    await expect(retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2027-01-01' })).rejects.toMatchObject({ code: 'ROOM_HAS_FUTURE_OVERRIDES', httpStatus: 409 })

    const overrides = await listOverrides(ctx, hotel.id, period.id)
    await deleteOverride(ctx, hotel.id, period.id, overrides[0]!.id)

    // effectiveFrom is still in the future relative to "today" (CLOCK), so the room stays AVAILABLE
    // today — what matters is that the retirement itself now succeeds (no ROOM_HAS_FUTURE_OVERRIDES).
    await expect(retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2027-01-01' })).resolves.toMatchObject({ lifecycle: { lastNight: '2026-12-31' } })
  })
})

describe('audit rows and real-error translation (test group 13)', () => {
  it('create/update/apply/delete-override/delete-period write audit rows with hotel_id set', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)

    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Audit Period', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await updateCapacityPeriod(ctx, hotel.id, period.id, { notes: 'note' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    const overrides = await listOverrides(ctx, hotel.id, period.id)
    await deleteOverride(ctx, hotel.id, period.id, overrides[0]!.id)

    const emptyPeriod = await createCapacityPeriod(ctx, hotel.id, { name: 'Deletable', kind: 'SPECIAL', startDate: '2027-09-01', endDate: '2027-09-05' })
    await deleteCapacityPeriod(ctx, hotel.id, emptyPeriod.id)

    const rows = await db.select().from(auditLog).where(eq(auditLog.hotelId, hotel.id))
    const actions = rows.map(r => r.action)
    expect(actions).toEqual(expect.arrayContaining(['CAPACITY_PERIOD_CREATED', 'CAPACITY_PERIOD_UPDATED', 'CAPACITY_OVERRIDES_APPLIED', 'CAPACITY_OVERRIDE_DELETED', 'CAPACITY_PERIOD_DELETED']))
    expect(rows.every(r => r.hotelId === hotel.id)).toBe(true)
  })

  it('an audit-write failure rolls back the period create', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    await expect(createCapacityPeriod(ctx, hotel.id, { name: 'Rollback', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })).rejects.toThrow('simulated audit failure')
    expect(await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.hotelId, hotel.id))).toEqual([])
  })

  it('an audit-write failure rolls back applyOverrides -- no override rows land', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Audit Fail Apply', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))
    await expect(apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })).rejects.toThrow('simulated audit failure')

    expect(await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)).toEqual([])
  })

  it('real-error translation: capacity_period_hotel_name_unique -> 409 ALREADY_EXISTS (fresh fixtures)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    await createCapacityPeriod(ctx, hotel.id, { name: 'Duplicate Name', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    await expect(createCapacityPeriod(ctx, hotel.id, { name: 'Duplicate Name', kind: 'SPECIAL', startDate: '2028-01-01', endDate: '2028-01-05' }))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })
  })
})

describe('preview (test group 15, S6)', () => {
  it('for the Room 401 example: before 4/4, after 6/6, correct totals/hotelTotals; writes nothing, no audit row', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Preview Period', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const result = await preview(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    expect(result.applied).toEqual([{ roomId: room401.id, roomNumber: '401', before: { physicalBeds: 4, sellableCapacity: 4 }, after: { physicalBeds: 6, sellableCapacity: 6 } }])
    expect(result.skipped).toEqual([])
    expect(result.totals).toEqual({ rooms: 1, bedsBefore: 4, bedsAfter: 6, sellableBefore: 4, sellableAfter: 6 })
    expect(result.hotelTotals).toEqual({ roomsInInventory: 1, sellableBefore: 4, sellableDuring: 6 })

    expect(await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)).toEqual([])
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, period.id), eq(auditLog.action, 'CAPACITY_OVERRIDES_APPLIED')))).toEqual([])
  })

  it('skipped rooms carry their reasons', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const lateRoom = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '405', inServiceFrom: '2027-06-01', features: [] })
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Preview Skips', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const result = await preview(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id, lateRoom.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    expect(result.applied).toHaveLength(1)
    expect(result.skipped).toEqual([{ roomId: lateRoom.id, roomNumber: '405', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }])
  })

  it('preview then apply of the SAME body yields IDENTICAL applied rows', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Preview Then Apply', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const body = { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE' as const, physicalBeds: 6, sellableCapacity: 6 } }

    const previewed = await preview(ctx, hotel.id, period.id, body)
    await apply(ctx, hotel.id, period.id, body)
    const written = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)

    expect(written).toHaveLength(previewed.applied.length)
    expect(written[0]).toMatchObject({ roomId: previewed.applied[0]!.roomId, physicalBeds: previewed.applied[0]!.after.physicalBeds, sellableCapacity: previewed.applied[0]!.after.sellableCapacity })
  })

  it('the same 404/422/409 cases as apply (foreign floorId, running period)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const { floor: otherFloor } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Preview Errors', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    await expect(preview(ctx, hotel.id, period.id, { selector: { floorIds: [otherFloor.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })

    const runningCtx = fullCtx(scope, hotel.id, () => new Date('2027-06-01T00:00:00Z'))
    await expect(preview(runningCtx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } }))
      .rejects.toMatchObject({ code: 'PERIOD_STARTED', httpStatus: 409 })
  })

  it('room.view-only caller -> 403', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Preview Perm', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const viewer = makeCtx(scope, { permissions: ['room.view'], hotelIds: [hotel.id], now: CLOCK })

    await expect(preview(viewer, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('period DTO (test group 16, S7)', () => {
  it('phase boundaries: 04-30 FUTURE, 05-01 and 07-31 ACTIVE, 08-01 ENDED (injected clock)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const period = await createCapacityPeriod(fullCtx(scope, hotel.id), hotel.id, { name: 'Phase Boundaries', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    const phaseAt = async (date: string) => (await getCapacityPeriod(fullCtx(scope, hotel.id, () => new Date(`${date}T12:00:00Z`)), hotel.id, period.id)).phase
    expect(await phaseAt('2027-04-30')).toBe('FUTURE')
    expect(await phaseAt('2027-05-01')).toBe('ACTIVE')
    expect(await phaseAt('2027-07-31')).toBe('ACTIVE')
    expect(await phaseAt('2027-08-01')).toBe('ENDED')
  })

  it('overrideCount and impact for a period with ABSOLUTE and DELTA rows', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const roomAbs = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const roomDelta = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '406', inServiceFrom: '2025-01-01', physicalBeds: 3, sellableCapacity: 3, features: [] })
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Impact Period', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [roomAbs.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [roomDelta.id] }, spec: { mode: 'DELTA', deltaBeds: 1, deltaSellable: 1 } })

    const dto = await getCapacityPeriod(ctx, hotel.id, period.id)
    expect(dto.overrideCount).toBe(2)
    // roomAbs: 6-4=2 beds, 2 sellable. roomDelta: (3+1)-3=1 beds, 1 sellable. Total: 3 beds, 3 sellable.
    expect(dto.impact).toEqual({ sellableDelta: 3, bedsDelta: 3 })
  })

  it('the list runs a FIXED number of statements regardless of how many periods exist', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    for (let i = 0; i < 5; i++) {
      await createCapacityPeriod(ctx, hotel.id, { name: `Bulk Period ${i}`, kind: 'SPECIAL', startDate: `2030-0${i + 1}-01`, endDate: `2030-0${i + 1}-05` })
    }
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Fixed Stmt Period', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    const listSpy = vi.spyOn(CapacityPeriodRepository.prototype, 'list')
    const countsSpy = vi.spyOn(CapacityPeriodRepository.prototype, 'overrideCountsByPeriod')
    const overridesSpy = vi.spyOn(RoomCapacityOverrideRepository.prototype, 'listAll')
    const versionsSpy = vi.spyOn(RoomBaseConfigRepository.prototype, 'versionsForRooms')

    const periods = await listCapacityPeriods(ctx, hotel.id, { includePast: true })
    expect(periods.length).toBeGreaterThanOrEqual(6)
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(countsSpy).toHaveBeenCalledTimes(1)
    expect(overridesSpy).toHaveBeenCalledTimes(1)
    expect(versionsSpy).toHaveBeenCalledTimes(1)
  })
})

describe('bulk removal (test group 17, S8)', () => {
  it('removes 3 of 5 overrides atomically with ONE audit row', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Bulk Remove', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const rooms = []
    for (let i = 0; i < 5; i++) {
      rooms.push(await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: `50${i}`, inServiceFrom: '2025-01-01', features: [] }))
    }
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: rooms.map(r => r.id) }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    const overrides = await listOverrides(ctx, hotel.id, period.id)
    expect(overrides).toHaveLength(5)

    const toRemove = overrides.slice(0, 3).map(o => o.id)
    const result = await removeOverrides(ctx, hotel.id, period.id, { overrideIds: toRemove })
    expect(result).toEqual({ removed: 3 })

    const remaining = await listOverrides(ctx, hotel.id, period.id)
    expect(remaining).toHaveLength(2)

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'CAPACITY_OVERRIDES_REMOVED'))
    expect(auditRows).toHaveLength(1)
  })

  it('an id from another period -> 422, nothing removed', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const periodA = await createCapacityPeriod(ctx, hotel.id, { name: 'Remove A', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const periodB = await createCapacityPeriod(ctx, hotel.id, { name: 'Remove B', kind: 'SPECIAL', startDate: '2028-01-01', endDate: '2028-01-05' })
    const roomB = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '601', inServiceFrom: '2025-01-01', features: [] })
    await apply(ctx, hotel.id, periodA.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    await apply(ctx, hotel.id, periodB.id, { selector: { roomIds: [roomB.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    const overridesA = await listOverrides(ctx, hotel.id, periodA.id)
    const overridesB = await listOverrides(ctx, hotel.id, periodB.id)

    await expect(removeOverrides(ctx, hotel.id, periodA.id, { overrideIds: [overridesA[0]!.id, overridesB[0]!.id] }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })

    expect(await listOverrides(ctx, hotel.id, periodA.id)).toHaveLength(1) // nothing removed
  })

  it('after the period starts -> 409 PERIOD_STARTED', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Remove Started', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    const overrides = await listOverrides(ctx, hotel.id, period.id)

    const runningCtx = fullCtx(scope, hotel.id, () => new Date('2027-06-01T00:00:00Z'))
    await expect(removeOverrides(runningCtx, hotel.id, period.id, { overrideIds: [overrides[0]!.id] })).rejects.toMatchObject({ code: 'PERIOD_STARTED', httpStatus: 409 })
  })

  it('1,001 ids -> 422 at the schema level', async () => {
    const tooMany = Array.from({ length: MAX_OVERRIDE_SELECTOR_ROOMS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(removeOverridesSchema.safeParse({ overrideIds: tooMany }).success).toBe(false)
  })
})

describe('override selector cap (test group 18, S9)', () => {
  it('a roomIds selector of 1,000 unique ids is accepted at validation level; 1,001 -> 422; duplicates removed before counting', () => {
    const uuidAt = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    const okIds = Array.from({ length: MAX_OVERRIDE_SELECTOR_ROOMS }, (_, i) => uuidAt(i))
    expect(overrideSelectorSchema.safeParse({ roomIds: okIds }).success).toBe(true)

    const tooMany = Array.from({ length: MAX_OVERRIDE_SELECTOR_ROOMS + 1 }, (_, i) => uuidAt(i))
    expect(overrideSelectorSchema.safeParse({ roomIds: tooMany }).success).toBe(false)

    const withDuplicates = [...okIds.slice(0, 500), ...okIds.slice(0, 500)] // 500 unique ids, doubled
    const parsed = overrideSelectorSchema.safeParse({ roomIds: withDuplicates })
    expect(parsed.success).toBe(true)
    if (parsed.success && 'roomIds' in parsed.data) expect(parsed.data.roomIds).toHaveLength(500)

    // The cap counts DISTINCT ids: 1,000 distinct ids plus repeats (1,005 raw) are accepted ...
    const atCapWithDuplicates = [...okIds, ...okIds.slice(0, 5)]
    const atCap = overrideSelectorSchema.safeParse({ roomIds: atCapWithDuplicates })
    expect(atCap.success).toBe(true)
    if (atCap.success && 'roomIds' in atCap.data) expect(atCap.data.roomIds).toHaveLength(MAX_OVERRIDE_SELECTOR_ROOMS)
    // ... while 1,001 distinct ids are rejected even when padded with repeats.
    expect(overrideSelectorSchema.safeParse({ roomIds: [...tooMany, ...tooMany.slice(0, 5)] }).success).toBe(false)
  })
})

describe('room DTOs show real season data (test group 19, S5 integration)', () => {
  it('room list/detail show effective.period and seasons for Room 401 (Hajj 2027)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const beforeCtx = fullCtx(scope, hotel.id, () => new Date('2027-01-01T12:00:00Z')) // "today" BEFORE the season, so the override can still be applied
    const room401 = await makeRoom401(beforeCtx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(beforeCtx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(beforeCtx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    const ctx = fullCtx(scope, hotel.id, () => new Date('2027-06-15T12:00:00Z')) // "today" NOW inside the season -- for the reads below

    const detail = await getRoom(ctx, hotel.id, room401.id)
    expect(detail.effective).toMatchObject({ physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE' })
    expect(detail.effective?.period).toMatchObject({ id: period.id, name: 'Hajj 2027', kind: 'HAJJ' })
    expect(detail.seasons).toHaveLength(1)
    expect(detail.seasons[0]).toMatchObject({ physicalBeds: 6, sellableCapacity: 6, period: { id: period.id, name: 'Hajj 2027', phase: 'ACTIVE' } })

    const list = await listRooms(ctx, hotel.id, { page: 1, pageSize: 20 })
    const item = list.items.find(i => i.id === room401.id)!
    expect(item.effective?.period).toMatchObject({ id: period.id, name: 'Hajj 2027' })
  })

  it('capacity-timeline refs.periods contains EXACTLY the periods referenced by the returned segments', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const periodA = await createCapacityPeriod(ctx, hotel.id, { name: 'Refs A', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const periodB = await createCapacityPeriod(ctx, hotel.id, { name: 'Refs B', kind: 'SPECIAL', startDate: '2028-01-01', endDate: '2028-01-31' }) // outside the queried range
    await apply(ctx, hotel.id, periodA.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })
    await apply(ctx, hotel.id, periodB.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 } })

    const timeline = await getRoomCapacityTimeline(ctx, hotel.id, room401.id, { from: '2027-01-01', to: '2027-12-31' })
    expect(Object.keys(timeline.refs.periods)).toEqual([periodA.id]) // periodB is outside the queried range
  })

  it('an override tail on nights the room is NOT in inventory (period extended past the room\'s last night, planted directly in the DB) yields no segment and no period ref', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    await retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2027-08-01' }) // last night in inventory: 2027-07-31
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj Tail', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 } })

    // The service refuses to create this state (N1: a date edit must keep every override covered) ...
    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-08-20' })).rejects.toMatchObject({ code: 'NOT_IN_INVENTORY_FOR_PERIOD', httpStatus: 409 })
    // ... so it is planted directly (the FK cascade moves the override row with the period) to prove
    // the timeline read stays defensive about such a tail anyway.
    await db.update(capacityPeriodTable).set({ endDate: '2027-08-20' }).where(eq(capacityPeriodTable.id, period.id))
    const [overrideRow] = await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id)).findByPeriod(period.id)
    expect(overrideRow?.validTo).toBe('2027-08-20')

    // Nights after retirement: the override row intersects the range but the room is not in inventory,
    // so there is no segment — and therefore no period ref (S13: refs = exactly the segments' periods).
    const outside = await getRoomCapacityTimeline(ctx, hotel.id, room401.id, { from: '2027-08-05', to: '2027-08-15' })
    expect(outside.segments).toEqual([])
    expect(outside.refs.periods).toEqual({})

    const straddling = await getRoomCapacityTimeline(ctx, hotel.id, room401.id, { from: '2027-07-25', to: '2027-08-10' })
    expect(straddling.segments).toEqual([{ from: '2027-07-25', to: '2027-07-31', physicalBeds: 6, sellableCapacity: 6, source: 'PERIOD_OVERRIDE', periodId: period.id }])
    expect(Object.keys(straddling.refs.periods)).toEqual([period.id])
  })
})

describe('final-review additions: audit rollback for every write, service-level cascade, foreign override, inactive hotel', () => {
  async function seeded() {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Audit Rollback', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, reason: 'Hajj surge' })
    const overrideRepo = new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id))
    return { scope, hotel, floor, roomType, ctx, room401, period, overrideRepo }
  }
  const failAudit = () => vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

  it('an audit-write failure rolls back a period update (name and dates unchanged, override not cascaded)', async () => {
    const { ctx, hotel, period, overrideRepo } = await seeded()
    failAudit()
    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { name: 'Renamed', endDate: '2027-06-30' })).rejects.toThrow('simulated audit failure')

    const [row] = await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.id, period.id))
    expect(row).toMatchObject({ name: 'Audit Rollback', endDate: '2027-07-31' })
    expect((await overrideRepo.findByPeriod(period.id))[0]?.validTo).toBe('2027-07-31')
  })

  it('an audit-write failure rolls back a period delete', async () => {
    const { ctx, hotel } = await seeded()
    const empty = await createCapacityPeriod(ctx, hotel.id, { name: 'Empty', kind: 'SPECIAL', startDate: '2027-09-01', endDate: '2027-09-05' })
    failAudit()
    await expect(deleteCapacityPeriod(ctx, hotel.id, empty.id)).rejects.toThrow('simulated audit failure')
    expect(await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.id, empty.id))).toHaveLength(1)
  })

  it('an audit-write failure rolls back a single override delete', async () => {
    const { ctx, hotel, period, overrideRepo } = await seeded()
    const [override] = await overrideRepo.findByPeriod(period.id)
    failAudit()
    await expect(deleteOverride(ctx, hotel.id, period.id, override!.id)).rejects.toThrow('simulated audit failure')
    expect(await overrideRepo.findByPeriod(period.id)).toHaveLength(1)
  })

  it('an audit-write failure rolls back a bulk removal', async () => {
    const { ctx, hotel, period, overrideRepo } = await seeded()
    const [override] = await overrideRepo.findByPeriod(period.id)
    failAudit()
    await expect(removeOverrides(ctx, hotel.id, period.id, { overrideIds: [override!.id] })).rejects.toThrow('simulated audit failure')
    expect(await overrideRepo.findByPeriod(period.id)).toHaveLength(1)
  })

  it('apply and bulk-remove audit rows carry hotel_id and the right before/after content', async () => {
    const { ctx, hotel, room401, period, overrideRepo } = await seeded()
    const [applyAudit] = await db.select().from(auditLog).where(and(eq(auditLog.hotelId, hotel.id), eq(auditLog.action, 'CAPACITY_OVERRIDES_APPLIED')))
    expect(applyAudit).toMatchObject({
      entityId: period.id,
      reason: 'Hajj surge',
      beforeData: null,
      afterData: { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 6, sellableCapacity: 6 }, applied: 1, skipped: 0 },
    })

    const [override] = await overrideRepo.findByPeriod(period.id)
    await removeOverrides(ctx, hotel.id, period.id, { overrideIds: [override!.id] })
    const [removeAudit] = await db.select().from(auditLog).where(and(eq(auditLog.hotelId, hotel.id), eq(auditLog.action, 'CAPACITY_OVERRIDES_REMOVED')))
    expect(removeAudit).toMatchObject({ entityId: period.id, afterData: null })
    expect(removeAudit!.beforeData).toEqual([expect.objectContaining({ id: override!.id, roomId: room401.id, periodId: period.id, physicalBeds: 6, sellableCapacity: 6 })])
  })

  it('service-level date edit: shrinking cascades and is audited; extending into another period\'s override -> 409 RANGE_OVERLAP, period/overrides unchanged, no audit row', async () => {
    const { ctx, hotel, room401, period, overrideRepo } = await seeded()
    const later = await createCapacityPeriod(ctx, hotel.id, { name: 'Later', kind: 'SPECIAL', startDate: '2027-08-15', endDate: '2027-09-15' })
    await apply(ctx, hotel.id, later.id, { selector: { roomIds: [room401.id] }, spec: { mode: 'ABSOLUTE', physicalBeds: 5, sellableCapacity: 5 } })

    const shrunk = await updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-07-15' })
    expect(shrunk.endDate).toBe('2027-07-15')
    expect((await overrideRepo.findByPeriod(period.id))[0]?.validTo).toBe('2027-07-15')
    const auditsBefore = await db.select().from(auditLog).where(and(eq(auditLog.entityId, period.id), eq(auditLog.action, 'CAPACITY_PERIOD_UPDATED')))
    expect(auditsBefore).toHaveLength(1)

    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-08-20' })).rejects.toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
    const [row] = await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.id, period.id))
    expect(row?.endDate).toBe('2027-07-15')
    expect((await overrideRepo.findByPeriod(period.id))[0]?.validTo).toBe('2027-07-15')
    expect((await overrideRepo.findByPeriod(later.id))[0]).toMatchObject({ validFrom: '2027-08-15', validTo: '2027-09-15' })
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, period.id), eq(auditLog.action, 'CAPACITY_PERIOD_UPDATED')))).toHaveLength(1)
  })

  it('a genuine no-op update writes nothing: no audit row, updated_at untouched', async () => {
    const { ctx, hotel, period } = await seeded()
    const [before] = await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.id, period.id))
    await updateCapacityPeriod(ctx, hotel.id, period.id, { name: 'Audit Rollback', endDate: '2027-07-31' })
    const [after] = await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.id, period.id))
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime())
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, period.id), eq(auditLog.action, 'CAPACITY_PERIOD_UPDATED')))).toEqual([])
  })

  it('an overrideId from another period or another hotel -> 404 OVERRIDE_NOT_FOUND, nothing deleted', async () => {
    const { scope, ctx, hotel, period, overrideRepo } = await seeded()
    const other = await createCapacityPeriod(ctx, hotel.id, { name: 'Other', kind: 'SPECIAL', startDate: '2028-01-01', endDate: '2028-01-05' })
    const [override] = await overrideRepo.findByPeriod(period.id)
    await expect(deleteOverride(ctx, hotel.id, other.id, override!.id)).rejects.toMatchObject({ code: 'OVERRIDE_NOT_FOUND', httpStatus: 404 })

    const { hotel: hotelB } = await setupHotel(scope)
    const ctxBoth = makeCtx(scope, { permissions: ['room.view', 'room.manage', 'capacity.manage'], hotelIds: [hotel.id, hotelB.id], now: CLOCK })
    const periodB = await createCapacityPeriod(ctxBoth, hotelB.id, { name: 'In B', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    await expect(deleteOverride(ctxBoth, hotelB.id, periodB.id, override!.id)).rejects.toMatchObject({ code: 'OVERRIDE_NOT_FOUND', httpStatus: 404 })
    expect(await overrideRepo.findByPeriod(period.id)).toHaveLength(1)
  })

  it('an INACTIVE hotel rejects every capacity write with 409 HOTEL_INACTIVE but still serves reads', async () => {
    const { scope } = await makeOrg(db)
    const hotel = await makeHotel(db, scope, { timezone: 'UTC', status: 'INACTIVE' })
    const ctx = fullCtx(scope, hotel.id)
    await expect(createCapacityPeriod(ctx, hotel.id, { name: 'Nope', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(listCapacityPeriods(ctx, hotel.id, { includePast: true })).resolves.toEqual([])
  })
})

describe('period date edits keep every override covered by base inventory (N1)', () => {
  const ABS6 = { mode: 'ABSOLUTE' as const, physicalBeds: 6, sellableCapacity: 6 }

  async function seededPeriod() {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const room401 = await makeRoom401(ctx, scope, hotel, floor, roomType)
    const period = await createCapacityPeriod(ctx, hotel.id, { name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })
    const overrideRepo = new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, hotel.id))
    return { scope, hotel, floor, roomType, ctx, room401, period, overrideRepo }
  }

  async function periodRow(periodId: string) {
    const [row] = await db.select().from(capacityPeriodTable).where(eq(capacityPeriodTable.id, periodId))
    return row!
  }

  async function periodUpdateAudits(periodId: string) {
    return db.select().from(auditLog).where(and(eq(auditLog.entityId, periodId), eq(auditLog.action, 'CAPACITY_PERIOD_UPDATED')))
  }

  it('the reproduced N1 scenario: override applied, room retired effective 08-01 (allowed), extending the period to 08-20 -> 409 NOT_IN_INVENTORY_FOR_PERIOD; period, override and audit log unchanged', async () => {
    const { ctx, hotel, room401, period, overrideRepo } = await seededPeriod()
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: ABS6 })
    await retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2027-08-01' }) // the override still ends 07-31: allowed

    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-08-20' })).rejects.toMatchObject({
      code: 'NOT_IN_INVENTORY_FOR_PERIOD',
      httpStatus: 409,
      details: { conflicts: [{ roomId: room401.id, roomNumber: '401', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] },
    })

    expect(await periodRow(period.id)).toMatchObject({ startDate: '2027-05-01', endDate: '2027-07-31' })
    const overrides = await overrideRepo.findByPeriod(period.id)
    expect(overrides.map(o => ({ validFrom: o.validFrom, validTo: o.validTo }))).toEqual([{ validFrom: '2027-05-01', validTo: '2027-07-31' }])
    expect(await periodUpdateAudits(period.id)).toEqual([])

    // A name-only edit of the same period is unaffected (no date change, no coverage check).
    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { name: 'Hajj 2027 (renamed)' })).resolves.toMatchObject({ name: 'Hajj 2027 (renamed)', endDate: '2027-07-31' })
  })

  it('moving the start before an overridden room was commissioned -> 409 NOT_IN_INVENTORY_FOR_PERIOD (the candidate START is checked too), nothing changed', async () => {
    const { ctx, hotel, floor, roomType, period, overrideRepo } = await seededPeriod()
    const late = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: '2027-05-01', features: [] })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [late.id] }, spec: ABS6 })

    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { startDate: '2027-04-20' })).rejects.toMatchObject({
      code: 'NOT_IN_INVENTORY_FOR_PERIOD',
      httpStatus: 409,
      details: { conflicts: [{ roomId: late.id, roomNumber: '402', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] },
    })
    expect(await periodRow(period.id)).toMatchObject({ startDate: '2027-05-01', endDate: '2027-07-31' })
    expect((await overrideRepo.findByPeriod(period.id)).map(o => o.validFrom)).toEqual(['2027-05-01'])
    expect(await periodUpdateAudits(period.id)).toEqual([])
  })

  it('a valid extension still works: the room stays in inventory through 08-31, extending to 08-20 succeeds and cascades the override; extending to 09-05 (past 08-31) is refused', async () => {
    const { ctx, hotel, room401, period, overrideRepo } = await seededPeriod()
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: ABS6 })
    await retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2027-09-01' }) // last night in inventory: 2027-08-31

    const updated = await updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-08-20' })
    expect(updated).toMatchObject({ endDate: '2027-08-20', overrideCount: 1 })
    expect(await periodRow(period.id)).toMatchObject({ endDate: '2027-08-20' })
    expect((await overrideRepo.findByPeriod(period.id)).map(o => ({ validFrom: o.validFrom, validTo: o.validTo }))).toEqual([{ validFrom: '2027-05-01', validTo: '2027-08-20' }])
    expect(await periodUpdateAudits(period.id)).toHaveLength(1)

    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-09-05' })).rejects.toMatchObject({ code: 'NOT_IN_INVENTORY_FOR_PERIOD', httpStatus: 409 })
    expect(await periodRow(period.id)).toMatchObject({ endDate: '2027-08-20' })
    expect((await overrideRepo.findByPeriod(period.id))[0]?.validTo).toBe('2027-08-20')
    expect(await periodUpdateAudits(period.id)).toHaveLength(1)
  })

  it('multi-room atomicity: one of three overridden rooms cannot cover the new range -> the WHOLE edit is refused before any write; no period change, no override moved (not even the covered rooms\'), no audit row', async () => {
    const { ctx, hotel, floor, roomType, room401, period, overrideRepo } = await seededPeriod()
    const room402 = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: '2025-01-01', features: [] })
    const room403 = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '403', inServiceFrom: '2025-01-01', features: [] })
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id, room402.id, room403.id] }, spec: ABS6 })
    await retireRoom(ctx, hotel.id, room402.id, { effectiveFrom: '2027-08-01' })

    const periodUpdate = vi.spyOn(CapacityPeriodRepository.prototype, 'update')
    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { name: 'Extended', endDate: '2027-08-20' })).rejects.toMatchObject({
      code: 'NOT_IN_INVENTORY_FOR_PERIOD',
      httpStatus: 409,
      details: { conflicts: [{ roomId: room402.id, roomNumber: '402', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' }] },
    })
    expect(periodUpdate).not.toHaveBeenCalled() // validated for every room before any write statement

    expect(await periodRow(period.id)).toMatchObject({ name: 'Hajj 2027', startDate: '2027-05-01', endDate: '2027-07-31' })
    const overrides = await overrideRepo.findByPeriod(period.id)
    expect(overrides).toHaveLength(3)
    for (const o of overrides) expect({ validFrom: o.validFrom, validTo: o.validTo }).toEqual({ validFrom: '2027-05-01', validTo: '2027-07-31' })
    expect(await periodUpdateAudits(period.id)).toEqual([])
  })

  it('a date edit of a period with NO overrides takes no room lock and needs no coverage check', async () => {
    const { ctx, hotel, room401, period } = await seededPeriod()
    await retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2027-08-01' }) // irrelevant: the room has no override in this period
    const lockSpy = vi.spyOn(RoomRepository.prototype, 'lockByIds')
    const versionsSpy = vi.spyOn(RoomBaseConfigRepository.prototype, 'versionsForRooms')

    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-08-20' })).resolves.toMatchObject({ endDate: '2027-08-20', overrideCount: 0 })
    expect(lockSpy).not.toHaveBeenCalled()
    expect(versionsSpy).toHaveBeenCalledTimes(1) // only the response DTO's impact computation (unchanged)
    expect(await periodUpdateAudits(period.id)).toHaveLength(1)
  })

  it('an audit-write failure on a covered extension rolls back the period dates AND the cascaded override dates; no audit row', async () => {
    const { ctx, hotel, room401, period, overrideRepo } = await seededPeriod()
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: ABS6 })
    const lockSpy = vi.spyOn(RoomRepository.prototype, 'lockByIds')
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    await expect(updateCapacityPeriod(ctx, hotel.id, period.id, { endDate: '2027-08-20' })).rejects.toThrow('simulated audit failure')
    expect(lockSpy).toHaveBeenCalledTimes(1) // the coverage check (room lock) ran and passed — the AUDIT write is what failed
    vi.restoreAllMocks()

    expect(await periodRow(period.id)).toMatchObject({ startDate: '2027-05-01', endDate: '2027-07-31' })
    expect((await overrideRepo.findByPeriod(period.id)).map(o => ({ validFrom: o.validFrom, validTo: o.validTo }))).toEqual([{ validFrom: '2027-05-01', validTo: '2027-07-31' }])
    expect(await periodUpdateAudits(period.id)).toEqual([])
  })

  it('the period row is locked by updateCapacityPeriod and applyOverrides, but NOT by previewOverrides (still a non-locking read with the same calls)', async () => {
    const { ctx, hotel, room401, period } = await seededPeriod()
    const findSpy = vi.spyOn(CapacityPeriodRepository.prototype, 'findById')
    const lockSpy = vi.spyOn(RoomRepository.prototype, 'lockByIds')

    await preview(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: ABS6 })
    expect(findSpy.mock.calls).toEqual([[period.id, {}]]) // one plain (unlocked) read, exactly as before
    expect(lockSpy).not.toHaveBeenCalled()

    findSpy.mockClear()
    await apply(ctx, hotel.id, period.id, { selector: { roomIds: [room401.id] }, spec: ABS6 })
    expect(findSpy.mock.calls[0]).toEqual([period.id, { forUpdate: true }])

    findSpy.mockClear()
    await updateCapacityPeriod(ctx, hotel.id, period.id, { notes: 'locked' })
    expect(findSpy.mock.calls[0]).toEqual([period.id, { forUpdate: true }])
  })
})
