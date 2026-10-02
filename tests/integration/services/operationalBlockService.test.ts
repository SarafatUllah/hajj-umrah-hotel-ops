import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog, hotel as hotelTable, roomOperationalBlock } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { ForbiddenError, NotFoundError } from '../../../server/errors/domainError'
import { translateDbError } from '../../../server/errors/dbErrors'
import { HotelSettingRepository, OperationalBlockRepository, RoomBaseConfigRepository, RoomCapacityOverrideRepository, RoomRepository } from '../../../server/repositories/hotel'
import { AuditRepository } from '../../../server/repositories/tenant'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { MAX_BULK_ROOMS } from '../../../shared/constants/inventory'
import type { Permission } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { bulkCreateRoomBlocksSchema, createRoomBlockSchema, listRoomBlocksQuerySchema } from '../../../shared/schemas/roomBlock'
import { bulkCreateRoomBlocks, cancelRoomBlock, createRoomBlock, listRoomBlocks } from '../../../server/services/operationalBlockService'
import { bulkCreateRooms, createRoom, getRoom, listRooms, retireRoom } from '../../../server/services/roomService'
import { makeFloor, makeHotel, makeOrg, makeRoomBlock, makeRoomType, makeUser } from '../../support/fixtures'
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
  permissions?: readonly Permission[]
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

const TODAY = '2026-09-25'
/** Noon UTC on `date` — for a UTC hotel, the hotel-local today is `date`. */
const at = (date: string) => () => new Date(`${date}T12:00:00Z`)
const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions as Permission[]
const RECEPTION = ROLE_DEFINITIONS.RECEPTION!.permissions as Permission[]

/** Org + UTC hotel + floor + type + a real (named) Hotel Manager user + Room 401 in service since 2025-01-01. */
async function setup(opts: { timezone?: string } = {}) {
  const { scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope, { timezone: opts.timezone ?? 'UTC' })
  const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
  const roomType = await makeRoomType(db, scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
  const manager = await makeUser(db, scope, { fullName: 'Huda Manager' })
  const ctxOn = (date: string) => makeCtx(scope, { userId: manager.id, permissions: MANAGER, hotelIds: [hotel.id], now: at(date) })
  const ctx = ctxOn(TODAY)
  const room401 = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: '2025-01-01', features: [] })
  return { scope, hotel, floor, roomType, manager, ctx, ctxOn, room401, hotelScope: trustedHotelScope(scope, hotel.id) }
}

async function addRoom(ctx: AuthContext, hotelId: string, floorId: string, roomTypeId: string, roomNumber: string, inServiceFrom = '2025-01-01') {
  return createRoom(ctx, hotelId, { floorId, roomTypeId, roomNumber, inServiceFrom, features: [] })
}

async function blockRows(hotelId: string) {
  return db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.hotelId, hotelId))
}

async function blockAudits(hotelId: string) {
  return db.select().from(auditLog).where(eq(auditLog.hotelId, hotelId))
}

async function statusOf(ctx: AuthContext, hotelId: string, roomId: string, asOf: string) {
  const page = await listRooms(ctx, hotelId, { asOf, page: 1, pageSize: 200 })
  return page.items.find(i => i.id === roomId)!.status
}

// ---------------------------------------------------------------------------

describe('create (test group 2)', () => {
  it('creates one block of each kind with the S10 shape; nothing about capacity changes', async () => {
    const { hotel, ctx, room401, manager } = await setup()

    for (const [i, kind] of (['OPERATIONAL_BLOCK', 'MAINTENANCE', 'OUT_OF_SERVICE'] as const).entries()) {
      const startDate = `2026-10-0${i + 1}`
      const created = await createRoomBlock(ctx, hotel.id, room401.id, { kind, startDate, endDate: '2026-10-05', reason: `  Reason ${kind}  ` })
      expect(created).toMatchObject({
        room: { id: room401.id, roomNumber: '401' },
        kind,
        startDate,
        endDate: '2026-10-05',
        nights: 5 - i,
        reason: `Reason ${kind}`,
        phase: 'UPCOMING',
        cancelAction: 'CANCEL',
        createdBy: { id: manager.id, fullName: 'Huda Manager' },
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        endedEarly: null,
      })
    }
    expect(await blockRows(hotel.id)).toHaveLength(3)
    // Blocks never change capacity: the room's base versions are untouched.
    const versions = await new RoomBaseConfigRepository(db, trustedHotelScope(ctx.scope, hotel.id)).versionsForRoom(room401.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ physicalBeds: 4, sellableCapacity: 4, validTo: null })
  })

  it('a blank, whitespace-only or tab-only reason -> 422 REASON_REQUIRED, nothing written (service-level, bypassing zod)', async () => {
    const { hotel, ctx, room401 } = await setup()
    for (const reason of ['', '    ', '\t', ' \n ']) {
      await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason }))
        .rejects.toMatchObject({ code: 'REASON_REQUIRED', httpStatus: 422 })
    }
    expect(await blockRows(hotel.id)).toEqual([])
  })

  it('reason length cap at the service (bypassing zod): 500 chars -> created; 501 chars -> 422 REASON_TOO_LONG on create, bulk and cancel, nothing written; the cap counts the TRIMMED reason', async () => {
    const { hotel, ctx, room401 } = await setup()
    const body = { kind: 'MAINTENANCE' as const, startDate: '2026-10-01', endDate: '2026-10-02' }

    await expect(createRoomBlock(ctx, hotel.id, room401.id, { ...body, reason: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'REASON_TOO_LONG', httpStatus: 422 })
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { ...body, reason: 'x'.repeat(501), roomIds: [room401.id] })).rejects.toMatchObject({ code: 'REASON_TOO_LONG', httpStatus: 422 })
    expect(await blockRows(hotel.id)).toEqual([])

    const created = await createRoomBlock(ctx, hotel.id, room401.id, { ...body, reason: `  ${'y'.repeat(500)}  ` })
    expect(created.reason).toBe('y'.repeat(500))
    await expect(cancelRoomBlock(ctx, hotel.id, created.id, { reason: 'z'.repeat(501) })).rejects.toMatchObject({ code: 'REASON_TOO_LONG', httpStatus: 422 })
    expect((await blockRows(hotel.id))[0]).toMatchObject({ id: created.id, cancelledAt: null })
    await expect(cancelRoomBlock(ctx, hotel.id, created.id, { reason: 'z'.repeat(500) })).resolves.toMatchObject({ cancelReason: 'z'.repeat(500) })

    // Whitespace-only is unchanged: still REASON_REQUIRED (checked before the length cap), even when long.
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { ...body, reason: ' '.repeat(600) })).rejects.toMatchObject({ code: 'REASON_REQUIRED', httpStatus: 422 })
  })

  it('the zod schema rejects a blank reason, an unknown kind, endDate < startDate and unknown keys (422 at the HTTP boundary)', () => {
    const ok = { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'Leak' }
    expect(createRoomBlockSchema.safeParse(ok).success).toBe(true)
    expect(createRoomBlockSchema.safeParse({ ...ok, reason: '   ' }).success).toBe(false)
    expect(createRoomBlockSchema.safeParse({ ...ok, reason: '\t' }).success).toBe(false)
    expect(createRoomBlockSchema.safeParse({ ...ok, reason: 'x'.repeat(501) }).success).toBe(false)
    expect(createRoomBlockSchema.safeParse({ ...ok, kind: 'BOOKED' }).success).toBe(false)
    expect(createRoomBlockSchema.safeParse({ ...ok, endDate: '2026-09-30' }).success).toBe(false)
    expect(createRoomBlockSchema.safeParse({ ...ok, roomId: '00000000-0000-0000-0000-000000000001' }).success).toBe(false)
    expect(createRoomBlockSchema.safeParse({ ...ok, cancelledAt: '2026-10-01' }).success).toBe(false)
  })

  it('a start in the past (hotel-local, injected clock) -> 422 BLOCK_IN_PAST; today is allowed', async () => {
    const { hotel, ctx, room401 } = await setup()
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-09-24', endDate: '2026-09-30', reason: 'Leak' }))
      .rejects.toMatchObject({ code: 'BLOCK_IN_PAST', httpStatus: 422 })
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: TODAY, endDate: '2026-09-30', reason: 'Leak' })).resolves.toMatchObject({ phase: 'RUNNING' })
  })

  it('"today" is the HOTEL\'s: at 2026-09-25T12:00Z a Pacific/Kiritimati (UTC+14) hotel is already on 09-26, so a 09-25 start is in the past', async () => {
    const { hotel, ctx, room401 } = await setup({ timezone: 'Pacific/Kiritimati' })
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-09-25', endDate: '2026-09-30', reason: 'Leak' }))
      .rejects.toMatchObject({ code: 'BLOCK_IN_PAST' })
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-09-26', endDate: '2026-09-30', reason: 'Leak' })).resolves.toMatchObject({ phase: 'RUNNING' })
  })

  it('731 nights is the cap: 2026-09-25..2028-09-24 succeeds, one more night -> 422 BLOCK_TOO_LONG', async () => {
    const { hotel, ctx, room401 } = await setup()
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: TODAY, endDate: '2028-09-25', reason: 'Renovation' }))
      .rejects.toMatchObject({ code: 'BLOCK_TOO_LONG', httpStatus: 422 })
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: TODAY, endDate: '2028-09-24', reason: 'Renovation' })).resolves.toMatchObject({ nights: 731 })
  })

  it('endDate before startDate -> 422 INVALID_DATE_RANGE (service-level), nothing written', async () => {
    const { hotel, ctx, room401 } = await setup()
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-02', endDate: '2026-10-01', reason: 'Leak' }))
      .rejects.toMatchObject({ code: 'INVALID_DATE_RANGE', httpStatus: 422 })
    expect(await blockRows(hotel.id)).toEqual([])
  })

  it('nights outside the room\'s inventory -> 422 ROOM_NOT_IN_INVENTORY_FOR_BLOCK (not yet commissioned, retired mid-block); fully covered nights succeed', async () => {
    const { hotel, floor, roomType, ctx } = await setup()
    const future = await addRoom(ctx, hotel.id, floor.id, roomType.id, '501', '2026-10-05')
    await expect(createRoomBlock(ctx, hotel.id, future.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Snagging' }))
      .rejects.toMatchObject({ code: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK', httpStatus: 422 })
    await expect(createRoomBlock(ctx, hotel.id, future.id, { kind: 'MAINTENANCE', startDate: '2026-10-05', endDate: '2026-10-10', reason: 'Snagging' })).resolves.toBeDefined()

    const retiring = await addRoom(ctx, hotel.id, floor.id, roomType.id, '502')
    await retireRoom(ctx, hotel.id, retiring.id, { effectiveFrom: '2026-10-05' }) // last night 10-04
    await expect(createRoomBlock(ctx, hotel.id, retiring.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' }))
      .rejects.toMatchObject({ code: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK' })
    await expect(createRoomBlock(ctx, hotel.id, retiring.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-04', reason: 'Leak' })).resolves.toBeDefined()

    expect((await blockRows(hotel.id)).map(r => r.roomId).sort()).toEqual([future.id, retiring.id].sort())
  })
})

describe('overlap (test group 3)', () => {
  it('same kind overlapping -> 409 BLOCK_OVERLAP (friendly pre-check), nothing written', async () => {
    const { hotel, ctx, room401 } = await setup()
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Leak' })
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-10', endDate: '2026-10-12', reason: 'Paint' }))
      .rejects.toMatchObject({ code: 'BLOCK_OVERLAP', httpStatus: 409 })
    expect(await blockRows(hotel.id)).toHaveLength(1)
    expect((await blockAudits(hotel.id)).filter(a => a.action === 'BLOCK_CREATED')).toHaveLength(1)
  })

  it('a direct insert past the pre-check hits the real 23P01, translated to 409 RANGE_OVERLAP', async () => {
    const { hotel, ctx, room401, hotelScope } = await setup()
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Leak' })
    const caught = await new OperationalBlockRepository(db, hotelScope).insert({ roomId: room401.id, kind: 'MAINTENANCE', startDate: '2026-10-05', endDate: '2026-10-06', reason: 'x' }).catch(e => e)
    expect(translateDbError(caught)).toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
  })

  it('different kinds overlap fine; adjacent same kind is fine; after cancelling the first, its range is free again', async () => {
    const { hotel, ctx, room401 } = await setup()
    const first = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Leak' })
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Flood' })).resolves.toBeDefined()
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-11', endDate: '2026-10-12', reason: 'Paint' })).resolves.toBeDefined()

    await cancelRoomBlock(ctx, hotel.id, first.id, { reason: 'Fixed remotely' })
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Leak again' })).resolves.toBeDefined()
  })
})

describe('cancel / end early (test groups 4 and 14)', () => {
  it('an unstarted block is soft-cancelled: cancelled_* set, NO ended-early column, dates unchanged, audit BLOCK_CANCELLED with the reason', async () => {
    const { hotel, ctx, room401, manager } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Leak' })

    const result = await cancelRoomBlock(ctx, hotel.id, block.id, { reason: 'Plans changed' })
    expect(result).toMatchObject({ phase: 'CANCELLED', cancelAction: null, cancelledBy: { id: manager.id, fullName: 'Huda Manager' }, cancelReason: 'Plans changed', endedEarly: null, startDate: '2026-10-01', endDate: '2026-10-10' })
    expect(result.cancelledAt).toBe(at(TODAY)().toISOString())

    const [row] = await blockRows(hotel.id)
    expect(row).toMatchObject({ endDate: '2026-10-10', cancelledBy: manager.id, cancelReason: 'Plans changed', endedEarlyAt: null, endedEarlyBy: null, originalEndDate: null })
    const audit = (await blockAudits(hotel.id)).find(a => a.action === 'BLOCK_CANCELLED')
    expect(audit).toMatchObject({ entityType: 'room_block', entityId: block.id, hotelId: hotel.id, reason: 'Plans changed', actorUserId: manager.id })
  })

  it('a block starting TODAY is fully cancelled (CANCEL), even though it displays as RUNNING', async () => {
    const { hotel, ctx, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: TODAY, endDate: '2026-10-10', reason: 'Leak' })
    expect(block).toMatchObject({ phase: 'RUNNING', cancelAction: 'CANCEL' })
    await expect(cancelRoomBlock(ctx, hotel.id, block.id, { reason: 'False alarm' })).resolves.toMatchObject({ phase: 'CANCELLED', endedEarly: null })
  })

  it('a running block is ENDED YESTERDAY: S11 columns set together, audit BLOCK_ENDED_EARLY, nights before today still resolve as blocked, today onward free', async () => {
    const { hotel, ctx, ctxOn, room401, manager } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: TODAY, endDate: '2026-10-10', reason: 'Burst pipe' })

    const later = ctxOn('2026-10-03')
    const result = await cancelRoomBlock(later, hotel.id, block.id, { reason: 'Repair finished' })
    expect(result).toMatchObject({
      startDate: TODAY,
      endDate: '2026-10-02',
      nights: 8,
      phase: 'ENDED_EARLY',
      cancelAction: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      endedEarly: { at: at('2026-10-03')().toISOString(), by: { id: manager.id, fullName: 'Huda Manager' }, originalEndDate: '2026-10-10', reason: 'Repair finished' },
    })

    const [row] = await blockRows(hotel.id)
    expect(row).toMatchObject({ endDate: '2026-10-02', originalEndDate: '2026-10-10', endedEarlyBy: manager.id, cancelReason: 'Repair finished', cancelledAt: null, cancelledBy: null })
    expect(row?.endedEarlyAt?.toISOString()).toBe(at('2026-10-03')().toISOString())

    const audit = (await blockAudits(hotel.id)).find(a => a.action === 'BLOCK_ENDED_EARLY')
    expect(audit).toMatchObject({ entityType: 'room_block', entityId: block.id, hotelId: hotel.id, reason: 'Repair finished' })
    expect(audit?.beforeData).toEqual({ endDate: '2026-10-10' })
    expect(audit?.afterData).toMatchObject({ endDate: '2026-10-02', originalEndDate: '2026-10-10' })

    expect(await statusOf(later, hotel.id, room401.id, TODAY)).toBe('OUT_OF_SERVICE')
    expect(await statusOf(later, hotel.id, room401.id, '2026-10-02')).toBe('OUT_OF_SERVICE')
    expect(await statusOf(later, hotel.id, room401.id, '2026-10-03')).toBe('AVAILABLE')

    // The freed nights take a new same-kind block (exclusion constraint keys on the new end_date).
    await expect(createRoomBlock(later, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-03', endDate: '2026-10-10', reason: 'Second leak' })).resolves.toBeDefined()
  })

  it('a block ending today is still running: it ends yesterday', async () => {
    const { hotel, ctx, ctxOn, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: TODAY, endDate: '2026-09-28', reason: 'Leak' })
    await expect(cancelRoomBlock(ctxOn('2026-09-28'), hotel.id, block.id, { reason: 'Done' })).resolves.toMatchObject({ endDate: '2026-09-27', endedEarly: { originalEndDate: '2026-09-28' } })
  })

  it('a finished block -> 409 BLOCK_ALREADY_ENDED; a cancelled block -> 409 BLOCK_ALREADY_CANCELLED; an ended-early block -> 409 BLOCK_ALREADY_ENDED; rows unchanged and never deleted', async () => {
    const { hotel, ctx, ctxOn, room401 } = await setup()
    const finished = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: TODAY, endDate: '2026-09-27', reason: 'Leak' })
    const toCancel = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'VIP hold' })
    const toEnd = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: TODAY, endDate: '2026-10-20', reason: 'Fire damage' })
    const countBefore = (await blockRows(hotel.id)).length

    const later = ctxOn('2026-09-28')
    await expect(cancelRoomBlock(later, hotel.id, finished.id, { reason: 'x' })).rejects.toMatchObject({ code: 'BLOCK_ALREADY_ENDED', httpStatus: 409 })

    await cancelRoomBlock(later, hotel.id, toCancel.id, { reason: 'first' })
    await expect(cancelRoomBlock(later, hotel.id, toCancel.id, { reason: 'second' })).rejects.toMatchObject({ code: 'BLOCK_ALREADY_CANCELLED', httpStatus: 409 })

    await cancelRoomBlock(later, hotel.id, toEnd.id, { reason: 'repaired' })
    await expect(cancelRoomBlock(later, hotel.id, toEnd.id, { reason: 'again' })).rejects.toMatchObject({ code: 'BLOCK_ALREADY_ENDED', httpStatus: 409 })

    const rows = await blockRows(hotel.id)
    expect(rows).toHaveLength(countBefore) // never decreases: nothing is ever deleted
    expect(rows.find(r => r.id === toCancel.id)?.cancelReason).toBe('first')
    expect(rows.find(r => r.id === toEnd.id)).toMatchObject({ endDate: '2026-09-27', originalEndDate: '2026-10-20', cancelReason: 'repaired' })
    expect(rows.find(r => r.id === finished.id)).toMatchObject({ endDate: '2026-09-27', cancelledAt: null, endedEarlyAt: null })
  })

  it('a blank cancel reason -> 422 REASON_REQUIRED, block unchanged', async () => {
    const { hotel, ctx, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' })
    await expect(cancelRoomBlock(ctx, hotel.id, block.id, { reason: '  ' })).rejects.toMatchObject({ code: 'REASON_REQUIRED', httpStatus: 422 })
    expect((await blockRows(hotel.id))[0]?.cancelledAt).toBeNull()
  })
})

describe('foreign ids (test group 5) — nothing written in every case', () => {
  async function twoHotelsTwoOrgs() {
    const a = await setup()
    const hotelB = await makeHotel(db, a.scope, { timezone: 'UTC' })
    const floorB = await makeFloor(db, trustedHotelScope(a.scope, hotelB.id))
    const ctxAB = makeCtx(a.scope, { userId: a.manager.id, permissions: MANAGER, hotelIds: [a.hotel.id, hotelB.id], now: at(TODAY) })
    const roomInB = await addRoom(ctxAB, hotelB.id, floorB.id, a.roomType.id, '601')
    const other = await setup()
    return { ...a, hotelB, floorB, ctxAB, roomInB, other }
  }

  it('a roomId of hotel B under hotel A\'s route, of another org, or nonexistent -> the SAME 404 ROOM_NOT_FOUND', async () => {
    const { hotel, ctxAB, roomInB, other } = await twoHotelsTwoOrgs()
    const body = { kind: 'MAINTENANCE' as const, startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' }

    const sameOrg = await createRoomBlock(ctxAB, hotel.id, roomInB.id, body).catch(e => e)
    const foreignOrg = await createRoomBlock(ctxAB, hotel.id, other.room401.id, body).catch(e => e)
    const missing = await createRoomBlock(ctxAB, hotel.id, '00000000-0000-0000-0000-00000000dead', body).catch(e => e)
    for (const e of [sameOrg, foreignOrg, missing]) {
      expect(e).toBeInstanceOf(NotFoundError)
      expect({ code: e.code, message: e.message, status: e.httpStatus }).toEqual({ code: 'ROOM_NOT_FOUND', message: 'ROOM_NOT_FOUND', status: 404 })
    }
    expect(await db.select().from(roomOperationalBlock)).toEqual([])
  })

  it('a blockId of another hotel or another org -> the SAME 404 BLOCK_NOT_FOUND; the foreign block is untouched', async () => {
    const { hotel, hotelB, ctxAB, roomInB, other } = await twoHotelsTwoOrgs()
    const inB = await createRoomBlock(ctxAB, hotelB.id, roomInB.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'B' })
    const inOther = await createRoomBlock(other.ctx, other.hotel.id, other.room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Other' })

    const sameOrg = await cancelRoomBlock(ctxAB, hotel.id, inB.id, { reason: 'hack' }).catch(e => e)
    const foreignOrg = await cancelRoomBlock(ctxAB, hotel.id, inOther.id, { reason: 'hack' }).catch(e => e)
    const missing = await cancelRoomBlock(ctxAB, hotel.id, '00000000-0000-0000-0000-00000000dead', { reason: 'hack' }).catch(e => e)
    for (const e of [sameOrg, foreignOrg, missing]) expect({ cls: e instanceof NotFoundError, code: e.code, status: e.httpStatus }).toEqual({ cls: true, code: 'BLOCK_NOT_FOUND', status: 404 })

    const all = await db.select().from(roomOperationalBlock)
    expect(all.every(r => r.cancelledAt === null && r.endedEarlyAt === null)).toBe(true)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'BLOCK_CANCELLED'))).toEqual([])
  })

  it('bulk roomIds or floorId outside this hotel -> 422 INVALID_REFERENCE, nothing written', async () => {
    const { hotel, floorB, ctxAB, roomInB, room401, other } = await twoHotelsTwoOrgs()
    const base = { kind: 'MAINTENANCE' as const, startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' }

    for (const input of [
      { ...base, roomIds: [room401.id, roomInB.id] },
      { ...base, roomIds: [room401.id, other.room401.id] },
      { ...base, floorId: floorB.id },
      { ...base, floorId: other.floor.id },
    ]) {
      await expect(bulkCreateRoomBlocks(ctxAB, hotel.id, input)).rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
    }
    expect(await db.select().from(roomOperationalBlock)).toEqual([])
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'BLOCKS_BULK_CREATED'))).toEqual([])
  })
})

describe('bulk (test group 6)', () => {
  it('the floor selector creates one block per room in inventory (rooms with no inventory night in the range are not candidates); one audit row per block plus one summary', async () => {
    const { hotel, floor, roomType, ctx, room401 } = await setup()
    const r402 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '402')
    const r403 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '403')
    const retiredLongAgo = await addRoom(ctx, hotel.id, floor.id, roomType.id, '404', '2020-01-01')
    await retireRoom(ctx, hotel.id, retiredLongAgo.id, { effectiveFrom: TODAY })
    await addRoom(ctx, hotel.id, floor.id, roomType.id, '405', '2027-06-01') // commissioned after the block
    const otherFloor = await makeFloor(db, trustedHotelScope(ctx.scope, hotel.id))
    await addRoom(ctx, hotel.id, otherFloor.id, roomType.id, '901')

    const created = await bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'Group hold', floorId: floor.id })
    expect(created.map(b => b.room.roomNumber)).toEqual(['401', '402', '403'])
    expect(created.map(b => b.room.id)).toEqual([room401.id, r402.id, r403.id])
    expect(created.every(b => b.kind === 'OPERATIONAL_BLOCK' && b.phase === 'UPCOMING' && b.reason === 'Group hold')).toBe(true)

    const audits = await blockAudits(hotel.id)
    const perBlock = audits.filter(a => a.action === 'BLOCK_CREATED')
    expect(perBlock.map(a => a.entityId).sort()).toEqual(created.map(b => b.id).sort())
    expect(perBlock.every(a => a.entityType === 'room_block' && a.hotelId === hotel.id)).toBe(true)
    const summary = audits.filter(a => a.action === 'BLOCKS_BULK_CREATED')
    expect(summary).toHaveLength(1)
    expect(summary[0]).toMatchObject({ entityType: 'hotel', entityId: hotel.id, hotelId: hotel.id, reason: 'Group hold' })
    expect(summary[0]!.afterData).toMatchObject({ count: 3, selector: { floorId: floor.id } })
  })

  it('roomIds selector; a room on the floor only PARTLY in inventory -> 409 BLOCK_CONFLICT (ROOM_NOT_IN_INVENTORY_FOR_BLOCK), nothing written', async () => {
    const { hotel, floor, roomType, ctx, room401 } = await setup()
    const partial = await addRoom(ctx, hotel.id, floor.id, roomType.id, '402', '2026-10-02')

    const err = await bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'Leak', floorId: floor.id }).catch(e => e)
    expect(err).toMatchObject({ code: 'BLOCK_CONFLICT', httpStatus: 409, details: { conflicts: [{ roomId: partial.id, roomNumber: '402', reason: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK' }] } })

    const err2 = await bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'Leak', roomIds: [room401.id, partial.id] }).catch(e => e)
    expect(err2).toMatchObject({ code: 'BLOCK_CONFLICT', details: { conflicts: [{ roomId: partial.id, reason: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK' }] } })
    expect(await blockRows(hotel.id)).toEqual([])
    expect(await blockAudits(hotel.id).then(a => a.filter(x => x.action.startsWith('BLOCK')))).toEqual([])
  })

  it('one room with a same-kind overlap -> 409 with details.conflicts [{ roomId, roomNumber, reason }] and ZERO new blocks, no audit row', async () => {
    const { hotel, floor, roomType, ctx, room401 } = await setup()
    const r402 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '402')
    const r403 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '403')
    await createRoomBlock(ctx, hotel.id, r403.id, { kind: 'MAINTENANCE', startDate: '2026-10-03', endDate: '2026-10-04', reason: 'Leak' })
    const auditsBefore = (await blockAudits(hotel.id)).length

    const err = await bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'Paint', roomIds: [room401.id, r402.id, r403.id] }).catch(e => e)
    expect(err).toMatchObject({ code: 'BLOCK_CONFLICT', httpStatus: 409 })
    expect(err.details).toEqual({ conflicts: [{ roomId: r403.id, roomNumber: '403', reason: 'BLOCK_OVERLAP' }] })
    expect(await blockRows(hotel.id)).toHaveLength(1) // only the pre-existing one
    expect(await blockAudits(hotel.id)).toHaveLength(auditsBefore)

    // A DIFFERENT kind over the same rooms is fine.
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-03', reason: 'Inspection', roomIds: [room401.id, r402.id, r403.id] })).resolves.toHaveLength(3)
  })

  it(`more than MAX_BULK_ROOMS (${MAX_BULK_ROOMS}) rooms -> 422: roomIds at the schema and the service; a floor with ${MAX_BULK_ROOMS + 1} rooms in inventory at the service; nothing written`, async () => {
    const { hotel, floor, roomType, ctx } = await setup() // room 401 is on `floor`
    await bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: '2025-01-01', range: { from: 1000, to: 1199 } })

    const base = { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'Paint' }
    const ids = Array.from({ length: MAX_BULK_ROOMS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(bulkCreateRoomBlocksSchema.safeParse({ ...base, roomIds: ids }).success).toBe(false)
    expect(bulkCreateRoomBlocksSchema.safeParse({ ...base, roomIds: ids.slice(0, MAX_BULK_ROOMS) }).success).toBe(true)
    expect(bulkCreateRoomBlocksSchema.safeParse({ ...base, roomIds: ids.slice(0, 2), floorId: floor.id }).success).toBe(false) // both selectors
    expect(bulkCreateRoomBlocksSchema.safeParse(base).success).toBe(false) // neither

    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'Paint', roomIds: ids })).rejects.toMatchObject({ code: 'TOO_MANY_ROOMS', httpStatus: 422 })
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'Paint', floorId: floor.id })).rejects.toMatchObject({ code: 'TOO_MANY_ROOMS', httpStatus: 422 })
    expect(await blockRows(hotel.id)).toEqual([])
  })

  it('duplicate roomIds from a direct service call are de-duplicated (one block per room), not misreported as INVALID_REFERENCE', async () => {
    const { hotel, ctx, room401 } = await setup()
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'Paint', roomIds: [room401.id, room401.id] })).resolves.toHaveLength(1)
  })

  it('a floor with no room in inventory on those nights -> 422 NO_ROOMS_TO_BLOCK', async () => {
    const { hotel, ctx } = await setup()
    const emptyFloor = await makeFloor(db, trustedHotelScope(ctx.scope, hotel.id))
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'Paint', floorId: emptyFloor.id }))
      .rejects.toMatchObject({ code: 'NO_ROOMS_TO_BLOCK', httpStatus: 422 })
  })
})

describe('authorization (test group 7)', () => {
  it('Reception (room.view, no room.block): list -> 200, create/bulk/cancel -> 403, even with an invalid body (authorization runs first)', async () => {
    const { scope, hotel, ctx, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' })
    const reception = makeCtx(scope, { permissions: RECEPTION, hotelIds: [hotel.id], now: at(TODAY) })

    await expect(listRoomBlocks(reception, hotel.id, { from: TODAY, to: '2026-12-31', includeCancelled: false, page: 1, pageSize: 20 })).resolves.toMatchObject({ total: 1 })
    await expect(createRoomBlock(reception, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-10', endDate: '2026-10-11', reason: 'x' })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(createRoomBlock(reception, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2020-01-01', endDate: '2020-01-02', reason: '  ' })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(bulkCreateRoomBlocks(reception, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-10', endDate: '2026-10-11', reason: 'x', roomIds: [room401.id] })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(cancelRoomBlock(reception, hotel.id, block.id, { reason: 'x' })).rejects.toBeInstanceOf(ForbiddenError)
    expect(await blockRows(hotel.id)).toHaveLength(1)
  })

  it('Hotel Manager -> 201-equivalent create; a hotel-scoped user on another hotel -> 404 (list and writes)', async () => {
    const { scope, hotel, ctx, room401 } = await setup()
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' })).resolves.toBeDefined()

    const otherHotel = await makeHotel(db, scope, { timezone: 'UTC' })
    const scoped = makeCtx(scope, { permissions: MANAGER, hotelIds: [otherHotel.id], now: at(TODAY) })
    await expect(listRoomBlocks(scoped, hotel.id, { from: TODAY, to: TODAY, includeCancelled: false, page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404 })
    await expect(createRoomBlock(scoped, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-10', endDate: '2026-10-11', reason: 'x' })).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND', httpStatus: 404 })
  })

  it('an INACTIVE hotel -> 409 HOTEL_INACTIVE for create/bulk/cancel; the list still works', async () => {
    const { hotel, ctx, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' })
    await db.update(hotelTable).set({ status: 'INACTIVE' }).where(eq(hotelTable.id, hotel.id))

    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x' })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x', roomIds: [room401.id] })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE' })
    await expect(cancelRoomBlock(ctx, hotel.id, block.id, { reason: 'x' })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE' })
    await expect(listRoomBlocks(ctx, hotel.id, { from: TODAY, to: '2026-12-31', includeCancelled: false, page: 1, pageSize: 20 })).resolves.toMatchObject({ total: 1 })
    expect((await blockRows(hotel.id))[0]?.cancelledAt).toBeNull()
  })
})

/**
 * Task 16 fix round: same-room block writers now serialize on the room-row lock (proved in
 * roomInventoryLocking.test.ts), so two creates on one room can no longer reach the insert together
 * through the service. The database exclusion constraint stays the backstop for any writer that does
 * NOT take that lock — the races below bypass the lock (same scoped read, no FOR UPDATE) to keep
 * proving the backstop and its 409 translation.
 */
function bypassRoomLock() {
  const realFindById = RoomRepository.prototype.findById
  vi.spyOn(RoomRepository.prototype, 'findById').mockImplementation(function (this: RoomRepository, id: string) {
    return realFindById.call(this, id)
  })
  vi.spyOn(RoomRepository.prototype, 'lockByIds').mockImplementation(function (this: RoomRepository, ids: readonly string[]) {
    return this.findByIds(ids)
  })
}

describe('concurrency (test group 8, real PostgreSQL, two genuinely concurrent transactions)', () => {
  it('two same-kind overlapping creates whose pre-checks BOTH pass before either inserts (room lock bypassed): one succeeds, the other gets the DB-backed 409 RANGE_OVERLAP; one row, one audit row', async () => {
    const { hotel, ctx, room401 } = await setup()
    bypassRoomLock()

    // Barrier: each transaction runs the REAL findActiveOverlapping pre-check, then waits until BOTH
    // have finished it before either proceeds to insert — so both pre-checks provably saw no
    // conflict, and only the database exclusion constraint can stop the loser.
    const realPreCheck = OperationalBlockRepository.prototype.findActiveOverlapping
    let arrived = 0
    let release!: () => void
    const bothPreChecked = new Promise<void>((resolve) => { release = resolve })
    const preCheckResults: number[] = []
    const spy = vi.spyOn(OperationalBlockRepository.prototype, 'findActiveOverlapping').mockImplementation(async function (this: OperationalBlockRepository, ...args) {
      const rows = await realPreCheck.apply(this, args)
      preCheckResults.push(rows.length)
      if (++arrived === 2) release()
      await bothPreChecked
      return rows
    })

    const results = await Promise.allSettled([
      createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'A' }),
      createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-05', endDate: '2026-10-15', reason: 'B' }),
    ])
    spy.mockRestore()

    expect(preCheckResults).toEqual([0, 0]) // neither pre-check saw the other
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })

    const winnerReason = results[0]!.status === 'fulfilled' ? 'A' : 'B'
    const rows = await blockRows(hotel.id)
    expect(rows.map(r => r.reason)).toEqual([winnerReason])
    const audits = (await blockAudits(hotel.id)).filter(a => a.action === 'BLOCK_CREATED')
    expect(audits.map(a => a.entityId)).toEqual([rows[0]!.id])
  })

  it('INSERTs released at the same instant (repeated, room lock bypassed): the loser always gets 409 RANGE_OVERLAP (PostgreSQL may answer 23P01 or a 40P01 deadlock); exactly one row', async () => {
    bypassRoomLock()
    for (let attempt = 0; attempt < 3; attempt++) {
      const { hotel, ctx, room401 } = await setup()
      const realInsert = OperationalBlockRepository.prototype.insert
      let arrived = 0
      let release!: () => void
      const bothReady = new Promise<void>((resolve) => { release = resolve })
      const spy = vi.spyOn(OperationalBlockRepository.prototype, 'insert').mockImplementation(async function (this: OperationalBlockRepository, ...args) {
        if (++arrived === 2) release()
        await bothReady
        return realInsert.apply(this, args)
      })

      const results = await Promise.allSettled([
        createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'A' }),
        createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'B' }),
      ])
      spy.mockRestore()

      const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.reason).toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
      expect(await blockRows(hotel.id)).toHaveLength(1)
      expect((await blockAudits(hotel.id)).filter(a => a.action === 'BLOCK_CREATED')).toHaveLength(1)
    }
  })

  it('a 40P01 deadlock raised by the block insert is translated to 409 RANGE_OVERLAP and nothing is written (deterministic)', async () => {
    const { hotel, ctx, room401 } = await setup()
    const deadlock = Object.assign(new Error('Failed query: insert into "room_operational_block"'), { cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }) })
    vi.spyOn(OperationalBlockRepository.prototype, 'insertMany').mockRejectedValue(deadlock)
    vi.spyOn(OperationalBlockRepository.prototype, 'insert').mockRejectedValue(deadlock)

    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x' })).rejects.toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x', roomIds: [room401.id] })).rejects.toMatchObject({ code: 'RANGE_OVERLAP', httpStatus: 409 })
    expect(await blockRows(hotel.id)).toEqual([])
    expect((await blockAudits(hotel.id)).filter(a => a.action.startsWith('BLOCK'))).toEqual([])
  })

  it('two concurrent cancels of the same block serialize on the row lock: one succeeds, the other 409s; one audit row', async () => {
    const { hotel, ctx, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'Leak' })

    const results = await Promise.allSettled([
      cancelRoomBlock(ctx, hotel.id, block.id, { reason: 'first' }),
      cancelRoomBlock(ctx, hotel.id, block.id, { reason: 'second' }),
    ])
    const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'BLOCK_ALREADY_CANCELLED', httpStatus: 409 })
    expect((await blockAudits(hotel.id)).filter(a => a.action === 'BLOCK_CANCELLED')).toHaveLength(1)
  })
})

describe('retire guard (test group 9)', () => {
  it('an active block ending on/after the retirement date -> 409 ROOM_HAS_ACTIVE_BLOCKS (room unchanged); after cancelling it -> retirement succeeds', async () => {
    const { hotel, ctx, room401, hotelScope } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'Leak' })

    await expect(retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2026-10-10' })).rejects.toMatchObject({ code: 'ROOM_HAS_ACTIVE_BLOCKS', httpStatus: 409 })
    await expect(retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2026-10-05' })).rejects.toMatchObject({ code: 'ROOM_HAS_ACTIVE_BLOCKS' })
    expect((await new RoomBaseConfigRepository(db, hotelScope).versionsForRoom(room401.id))[0]?.validTo).toBeNull()

    await cancelRoomBlock(ctx, hotel.id, block.id, { reason: 'Room is being retired' })
    await expect(retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2026-10-05' })).resolves.toMatchObject({ lifecycle: { lastNight: '2026-10-04' } })
  })

  it('a block ending the night BEFORE the retirement date does not block it', async () => {
    const { hotel, ctx, room401 } = await setup()
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-04', reason: 'Leak' })
    await expect(retireRoom(ctx, hotel.id, room401.id, { effectiveFrom: '2026-10-05' })).resolves.toBeDefined()
  })
})

describe('audit atomicity (test group 11) — the DB is re-queried after every forced failure', () => {
  function failAudit() {
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))
  }

  it('create: no block row survives', async () => {
    const { hotel, ctx, room401 } = await setup()
    failAudit()
    await expect(createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x' })).rejects.toThrow('simulated audit failure')
    expect(await blockRows(hotel.id)).toEqual([])
  })

  it('bulk: no block row survives (the per-block audit rows were already written when the summary fails)', async () => {
    const { hotel, floor, roomType, ctx, room401 } = await setup()
    const r402 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '402')
    const realRecord = AuditRepository.prototype.record
    vi.spyOn(AuditRepository.prototype, 'record').mockImplementation(async function (this: AuditRepository, entry) {
      if (entry.action === 'BLOCKS_BULK_CREATED') throw new Error('simulated audit failure')
      return realRecord.call(this, entry)
    })
    await expect(bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x', roomIds: [room401.id, r402.id] })).rejects.toThrow('simulated audit failure')
    expect(await blockRows(hotel.id)).toEqual([])
    expect((await blockAudits(hotel.id)).filter(a => a.action === 'BLOCK_CREATED')).toEqual([])
  })

  it('cancel: the row is still active (cancelled_* null)', async () => {
    const { hotel, ctx, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x' })
    failAudit()
    await expect(cancelRoomBlock(ctx, hotel.id, block.id, { reason: 'y' })).rejects.toThrow('simulated audit failure')
    expect(await blockRows(hotel.id)).toEqual([expect.objectContaining({ id: block.id, cancelledAt: null, cancelledBy: null, cancelReason: null })])
  })

  it('end early: end_date and every S11 column are back to their pre-call values', async () => {
    const { hotel, ctx, ctxOn, room401 } = await setup()
    const block = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: TODAY, endDate: '2026-10-05', reason: 'x' })
    failAudit()
    await expect(cancelRoomBlock(ctxOn('2026-09-28'), hotel.id, block.id, { reason: 'y' })).rejects.toThrow('simulated audit failure')
    expect(await blockRows(hotel.id)).toEqual([expect.objectContaining({ id: block.id, endDate: '2026-10-05', originalEndDate: null, endedEarlyAt: null, endedEarlyBy: null, cancelReason: null })])
  })

  it('every block audit row carries hotel_id', async () => {
    const { hotel, floor, roomType, ctx, ctxOn, room401 } = await setup()
    const r402 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '402')
    const a = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: TODAY, endDate: '2026-10-05', reason: 'x' })
    const b = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x' })
    await bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'x', roomIds: [r402.id] })
    await cancelRoomBlock(ctx, hotel.id, b.id, { reason: 'y' })
    await cancelRoomBlock(ctxOn('2026-09-27'), hotel.id, a.id, { reason: 'z' })

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.organizationId, ctx.scope.organizationId)))
    const blockAuditRows = rows.filter(r => ['BLOCK_CREATED', 'BLOCK_CANCELLED', 'BLOCK_ENDED_EARLY', 'BLOCKS_BULK_CREATED'].includes(r.action))
    expect(blockAuditRows.map(r => r.action).sort()).toEqual(['BLOCKS_BULK_CREATED', 'BLOCK_CANCELLED', 'BLOCK_CREATED', 'BLOCK_CREATED', 'BLOCK_CREATED', 'BLOCK_ENDED_EARLY'])
    expect(blockAuditRows.every(r => r.hotelId === hotel.id)).toBe(true)
  })
})

describe('BlockListItem (test group 13, S10) and the list endpoint', () => {
  it('cancelAction: CANCEL for a block starting today (phase RUNNING), END_EARLY for one that started yesterday, null for ended or cancelled', async () => {
    const { hotel, ctxOn, room401 } = await setup()
    const yesterday = ctxOn('2026-09-24')
    const startedYesterday = await createRoomBlock(yesterday, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-09-24', endDate: '2026-09-30', reason: 'a' })
    const endedYesterday = await createRoomBlock(yesterday, hotel.id, room401.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-09-24', endDate: '2026-09-24', reason: 'b' })
    const today = ctxOn(TODAY)
    const startsToday = await createRoomBlock(today, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: TODAY, endDate: '2026-09-26', reason: 'c' })
    const cancelled = await createRoomBlock(today, hotel.id, room401.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'd' })
    await cancelRoomBlock(today, hotel.id, cancelled.id, { reason: 'gone' })

    const page = await listRoomBlocks(today, hotel.id, { from: '2026-09-01', to: '2026-12-31', includeCancelled: true, page: 1, pageSize: 20 })
    const byId = new Map(page.items.map(i => [i.id, i]))
    expect(byId.get(startsToday.id)).toMatchObject({ phase: 'RUNNING', cancelAction: 'CANCEL' })
    expect(byId.get(startedYesterday.id)).toMatchObject({ phase: 'RUNNING', cancelAction: 'END_EARLY' })
    expect(byId.get(endedYesterday.id)).toMatchObject({ phase: 'ENDED', cancelAction: null })
    expect(byId.get(cancelled.id)).toMatchObject({ phase: 'CANCELLED', cancelAction: null, cancelReason: 'gone' })

    // Exact key set of the S10/S11 DTO — nothing more, nothing less.
    expect(Object.keys(byId.get(startsToday.id)!).sort()).toEqual(['cancelAction', 'cancelReason', 'cancelledAt', 'cancelledBy', 'createdAt', 'createdBy', 'endDate', 'endedEarly', 'id', 'kind', 'nights', 'phase', 'reason', 'room', 'startDate'].sort())
  })

  it('createdBy.fullName resolves within the organization only: an actor id of ANOTHER org yields createdBy null', async () => {
    const { hotel, ctx, room401, hotelScope, manager } = await setup()
    const { scope: otherOrg } = await makeOrg(db)
    const outsider = await makeUser(db, otherOrg, { fullName: 'Outsider Name' })
    const planted = await makeRoomBlock(db, hotelScope, room401.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-11-01', endDate: '2026-11-02', createdBy: outsider.id })
    const own = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-11-01', endDate: '2026-11-02', reason: 'own' })

    const page = await listRoomBlocks(ctx, hotel.id, { from: '2026-11-01', to: '2026-11-30', includeCancelled: false, page: 1, pageSize: 20 })
    expect(page.items.find(i => i.id === planted.id)?.createdBy).toBeNull()
    expect(page.items.find(i => i.id === own.id)?.createdBy).toEqual({ id: manager.id, fullName: 'Huda Manager' })
  })

  it('filters: the window intersects, kind, roomId, includeCancelled; ordering by start date then room number; pagination with total', async () => {
    const { hotel, floor, roomType, ctx, room401 } = await setup()
    const r402 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '402')
    const r10 = await addRoom(ctx, hotel.id, floor.id, roomType.id, '10')
    await createRoomBlock(ctx, hotel.id, r402.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'a' })
    await createRoomBlock(ctx, hotel.id, r10.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-05', reason: 'b' })
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-09-28', endDate: '2026-09-30', reason: 'c' })
    const cancelled = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-12-01', endDate: '2026-12-05', reason: 'd' })
    await cancelRoomBlock(ctx, hotel.id, cancelled.id, { reason: 'x' })

    const list = (q: Partial<Parameters<typeof listRoomBlocks>[2]>) => listRoomBlocks(ctx, hotel.id, { from: '2026-09-01', to: '2026-12-31', includeCancelled: false, page: 1, pageSize: 20, ...q })

    expect((await list({})).items.map(i => i.room.roomNumber)).toEqual(['401', '10', '402'])
    expect((await list({ includeCancelled: true })).total).toBe(4)
    expect((await list({ from: '2026-09-30', to: '2026-09-30' })).items.map(i => i.reason)).toEqual(['c'])
    expect((await list({ from: '2026-10-05', to: '2026-10-05' })).total).toBe(2) // inclusive last night
    expect((await list({ from: '2026-10-06', to: '2026-11-30' })).total).toBe(0)
    expect((await list({ kind: 'OUT_OF_SERVICE' })).items.map(i => i.reason)).toEqual(['c'])
    expect((await list({ roomId: r402.id })).items.map(i => i.reason)).toEqual(['a'])

    const p1 = await list({ pageSize: 2, page: 1 })
    const p2 = await list({ pageSize: 2, page: 2 })
    expect(p1).toMatchObject({ total: 3, page: 1, pageSize: 2 })
    expect([...p1.items, ...p2.items].map(i => i.reason)).toEqual(['c', 'b', 'a'])
  })

  it('the list runs a FIXED number of repository calls regardless of how many blocks match (no N+1)', async () => {
    const { hotel, floor, roomType, ctx } = await setup()
    const created = await bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: '2025-01-01', range: { from: 500, to: 529 } })
    await bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'x', roomIds: created.map(r => r.id) })

    const listSpy = vi.spyOn(OperationalBlockRepository.prototype, 'list')
    const findByIdSpy = vi.spyOn(OperationalBlockRepository.prototype, 'findById')
    const roomSpy = vi.spyOn(RoomRepository.prototype, 'findById')
    const page = await listRoomBlocks(ctx, hotel.id, { from: TODAY, to: '2026-12-31', includeCancelled: false, page: 1, pageSize: 200 })
    expect(page.items).toHaveLength(30)
    expect(page.items.every(i => i.createdBy?.fullName === 'Huda Manager')).toBe(true)
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(findByIdSpy).not.toHaveBeenCalled()
    expect(roomSpy).not.toHaveBeenCalled()
  })

  it('the list query schema: window required and ≤ 400 nights, pageSize ≤ 200, strict keys', () => {
    const ok = { from: '2026-09-01', to: '2026-09-30' }
    expect(listRoomBlocksQuerySchema.safeParse(ok).success).toBe(true)
    expect(listRoomBlocksQuerySchema.safeParse({ from: '2026-09-01' }).success).toBe(false)
    expect(listRoomBlocksQuerySchema.safeParse({ from: '2026-01-01', to: '2027-02-05' }).success).toBe(false) // 401 nights
    expect(listRoomBlocksQuerySchema.safeParse({ from: '2026-01-01', to: '2027-02-04' }).success).toBe(true) // exactly 400 nights
    expect(listRoomBlocksQuerySchema.safeParse({ from: '2026-09-30', to: '2026-09-01' }).success).toBe(false)
    expect(listRoomBlocksQuerySchema.safeParse({ ...ok, pageSize: '201' }).success).toBe(false)
    expect(listRoomBlocksQuerySchema.safeParse({ ...ok, pageSize: '200' }).success).toBe(true)
    expect(listRoomBlocksQuerySchema.safeParse({ ...ok, hotelId: 'x' }).success).toBe(false)
    expect(listRoomBlocksQuerySchema.safeParse({ ...ok, includeCancelled: 'yes' }).success).toBe(false)
    const badDate = listRoomBlocksQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' })
    expect(badDate.success).toBe(false)
    expect(badDate.error?.issues).toHaveLength(1) // reported once (by the field), not again by the range check
  })
})

describe('room status (test group 15, S5)', () => {
  it('OUT_OF_SERVICE over MAINTENANCE over OPERATIONAL_BLOCK on a night where several apply; each alone shows itself; outside every block AVAILABLE', async () => {
    const { hotel, ctx, room401 } = await setup()
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-10-01', endDate: '2026-10-10', reason: 'hold' })
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-03', endDate: '2026-10-10', reason: 'paint' })
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-05', endDate: '2026-10-06', reason: 'flood' })

    expect(await statusOf(ctx, hotel.id, room401.id, '2026-09-30')).toBe('AVAILABLE')
    expect(await statusOf(ctx, hotel.id, room401.id, '2026-10-01')).toBe('OPERATIONAL_BLOCK')
    expect(await statusOf(ctx, hotel.id, room401.id, '2026-10-03')).toBe('MAINTENANCE')
    expect(await statusOf(ctx, hotel.id, room401.id, '2026-10-05')).toBe('OUT_OF_SERVICE')
    expect(await statusOf(ctx, hotel.id, room401.id, '2026-10-07')).toBe('MAINTENANCE')
    expect(await statusOf(ctx, hotel.id, room401.id, '2026-10-11')).toBe('AVAILABLE')
  })

  it('getRoom (detail) shows the block-aware status on the hotel\'s today', async () => {
    const { hotel, ctx, ctxOn, room401 } = await setup()
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: TODAY, endDate: '2026-10-02', reason: 'paint' })
    expect((await getRoom(ctx, hotel.id, room401.id)).status).toBe('MAINTENANCE')
    expect((await getRoom(ctxOn('2026-10-03'), hotel.id, room401.id)).status).toBe('AVAILABLE')
  })

  it('MAINTENANCE with inventory.maintenanceBlocksSales = false still shows status MAINTENANCE (the setting only affects sellability), and the setting IS read', async () => {
    const { hotel, ctx, room401, hotelScope } = await setup()
    await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'MAINTENANCE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'paint' })
    await new HotelSettingRepository(db, hotelScope).upsert('inventory.maintenanceBlocksSales', false)

    const settingsSpy = vi.spyOn(HotelSettingRepository.prototype, 'getAll')
    expect(await statusOf(ctx, hotel.id, room401.id, '2026-10-01')).toBe('MAINTENANCE')
    expect(settingsSpy).toHaveBeenCalledTimes(1)
    expect(await settingsSpy.mock.results[0]!.value).toEqual([expect.objectContaining({ key: 'inventory.maintenanceBlocksSales', value: false })])
  })

  it('a cancelled block does not affect status', async () => {
    const { hotel, ctx, room401 } = await setup()
    const cancelled = await createRoomBlock(ctx, hotel.id, room401.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'x' })
    await cancelRoomBlock(ctx, hotel.id, cancelled.id, { reason: 'no' })
    expect(await statusOf(ctx, hotel.id, room401.id, '2026-10-01')).toBe('AVAILABLE')
  })

  it('a 40-room page with blocks costs a FIXED number of block/setting reads (one each), never one per room', async () => {
    const { hotel, floor, roomType, ctx } = await setup()
    const created = await bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: '2025-01-01', range: { from: 600, to: 639 } })
    await bulkCreateRoomBlocks(ctx, hotel.id, { kind: 'OUT_OF_SERVICE', startDate: '2026-10-01', endDate: '2026-10-02', reason: 'x', roomIds: created.map(r => r.id) })

    const blocksSpy = vi.spyOn(OperationalBlockRepository.prototype, 'findActiveForRoomsOn')
    const settingsSpy = vi.spyOn(HotelSettingRepository.prototype, 'getAll')
    const overridesSpy = vi.spyOn(RoomCapacityOverrideRepository.prototype, 'findByRoomIds')
    const versionsSpy = vi.spyOn(RoomBaseConfigRepository.prototype, 'versionsForRooms')
    const page = await listRooms(ctx, hotel.id, { asOf: '2026-10-01', page: 1, pageSize: 200 })
    expect(page.items.filter(i => i.status === 'OUT_OF_SERVICE')).toHaveLength(40)
    expect(page.items.find(i => i.roomNumber === '401')?.status).toBe('AVAILABLE')
    for (const spy of [blocksSpy, settingsSpy, overridesSpy, versionsSpy]) expect(spy).toHaveBeenCalledTimes(1)
    expect(blocksSpy.mock.calls[0]![0]).toHaveLength(41)
  })
})
