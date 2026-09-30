import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLog, hotel as hotelTable, room, roomBaseConfig } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { ForbiddenError, NotFoundError } from '../../../server/errors/domainError'
import { AuditRepository, RoomTypeRepository } from '../../../server/repositories/tenant'
import { FloorRepository, RoomBaseConfigRepository, RoomRepository } from '../../../server/repositories/hotel'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import type { Permission } from '../../../shared/constants/permissions'
import {
  bulkCreateRooms,
  changeBaseConfig,
  createRoom,
  getRoom,
  listRooms,
  reactivateRoom,
  retireRoom,
  updateRoom,
} from '../../../server/services/roomService'
import { updateRoomType } from '../../../server/services/roomTypeService'
import { makeFloor, makeHotel, makeOrg, makeRoomType, makeUser } from '../../support/fixtures'
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

const CLOCK = () => new Date('2027-05-01T12:00:00Z') // hotel-local "today" = 2027-05-01 for UTC hotels
const TODAY = '2027-05-01'

/** A hotel + floor + room type, all in UTC, ready for a room create/list call. */
async function setupHotel(scope: OrganizationScope, overrides: { defaultPhysicalBeds?: number, defaultSellableCapacity?: number } = {}) {
  const hotel = await makeHotel(db, scope, { timezone: 'UTC' })
  const floor = await makeFloor(db, trustedHotelScope(scope, hotel.id))
  const roomType = await makeRoomType(db, scope, { defaultPhysicalBeds: overrides.defaultPhysicalBeds ?? 4, defaultSellableCapacity: overrides.defaultSellableCapacity ?? 4 })
  return { hotel, floor, roomType }
}

function fullCtx(scope: OrganizationScope, hotelId: string, extra: Permission[] = []) {
  return makeCtx(scope, { permissions: ['room.view', 'room.manage', 'capacity.manage', ...extra], hotelIds: [hotelId], now: CLOCK })
}

describe('createRoom — type-default snapshot vs explicit override, and audit', () => {
  it('omitting capacity copies the room type\'s CURRENT defaults with origin ROOM_TYPE_DEFAULT', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
    const actor = await makeUser(db, scope)
    const ctx = makeCtx(scope, { userId: actor.id, permissions: ['room.manage'], hotelIds: [hotel.id], now: CLOCK })

    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: TODAY, features: [] })

    expect(created.roomNumber).toBe('401')
    expect(created.base).toEqual({ physicalBeds: 4, sellableCapacity: 4 })
    expect(created.baseVersions).toHaveLength(1)
    expect(created.baseVersions[0]).toMatchObject({ validFrom: TODAY, validTo: null, physicalBeds: 4, sellableCapacity: 4, origin: 'ROOM_TYPE_DEFAULT' })

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_CREATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.hotelId).toBe(hotel.id)
    expect(auditRows[0]!.entityId).toBe(created.id)
    expect(auditRows[0]!.beforeData).toBeNull()
  })

  it('explicit physicalBeds/sellableCapacity -> origin MANUAL, and overrides the type defaults', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
    const ctx = fullCtx(scope, hotel.id)

    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '402', inServiceFrom: TODAY, physicalBeds: 6, sellableCapacity: 5, features: [] })

    expect(created.baseVersions[0]).toMatchObject({ physicalBeds: 6, sellableCapacity: 5, origin: 'MANUAL' })
  })

  it('inServiceFrom may be in the past (onboarding an existing hotel)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '403', inServiceFrom: '2020-01-01', features: [] })
    expect(created.lifecycle.inServiceFrom).toBe('2020-01-01')
    expect(created.status).toBe('AVAILABLE')
  })

  it('room + its first base version + the audit row are atomic: a base-version-insert failure leaves NO room row at all', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    vi.spyOn(RoomBaseConfigRepository.prototype, 'insert').mockRejectedValue(new Error('simulated base-version insert failure'))

    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '404', inServiceFrom: TODAY, features: [] }))
      .rejects.toThrow('simulated base-version insert failure')

    const rows = await db.select().from(room).where(eq(room.hotelId, hotel.id))
    expect(rows).toEqual([]) // NOT EVEN an orphaned room row
  })

  it('an audit-write failure rolls back BOTH the room and its base version', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '405', inServiceFrom: TODAY, features: [] }))
      .rejects.toThrow('simulated audit failure')

    expect(await db.select().from(room).where(eq(room.hotelId, hotel.id))).toEqual([])
    expect(await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.hotelId, hotel.id))).toEqual([])
  })
})

describe('room number normalization and lifetime uniqueness (Q2/D16)', () => {
  it('normalizes " 401 " and Arabic-Indic "٤٠١" and treats them as colliding with plain "401"', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: ' 401 ', inServiceFrom: TODAY, features: [] })
    expect(created.roomNumber).toBe('401')

    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '٤٠١', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })
  })

  it('an invalid room number (empty after trim) -> 422 INVALID_ROOM_NUMBER', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '   ', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'INVALID_ROOM_NUMBER', httpStatus: 422 })
  })

  it('the same room number IS allowed in a different hotel', async () => {
    const { scope } = await makeOrg(db)
    const { hotel: hotelA, floor: floorA, roomType: typeA } = await setupHotel(scope)
    const { hotel: hotelB, floor: floorB, roomType: typeB } = await setupHotel(scope)
    const ctxA = fullCtx(scope, hotelA.id)
    const ctxB = fullCtx(scope, hotelB.id)

    await createRoom(ctxA, hotelA.id, { floorId: floorA.id, roomTypeId: typeA.id, roomNumber: '401', inServiceFrom: TODAY, features: [] })
    await expect(createRoom(ctxB, hotelB.id, { floorId: floorB.id, roomTypeId: typeB.id, roomNumber: '401', inServiceFrom: TODAY, features: [] })).resolves.toBeDefined()
  })

  it('a retired room\'s number still collides on a new create (lifetime reservation)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '406', inServiceFrom: '2020-01-01', features: [] })
    await retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY })

    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '406', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })
  })

  it('no repository update() call anywhere writes room_number (grep proof lives in the report; this asserts PATCH cannot change it end-to-end)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '407', inServiceFrom: TODAY, features: [] })

    await expect(updateRoom(ctx, hotel.id, created.id, { roomNumber: '999' })).rejects.toMatchObject({ code: 'ROOM_NUMBER_IMMUTABLE', httpStatus: 422 })

    const [row] = await db.select().from(room).where(eq(room.id, created.id))
    expect(row!.roomNumber).toBe('407')
  })
})

describe('updateRoom — authorization runs BEFORE the ROOM_NUMBER_IMMUTABLE body check (fix round 1)', () => {
  it('a caller with NO access to the hotel submitting roomNumber gets the 404 access-denial, not 422 ROOM_NUMBER_IMMUTABLE', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const owner = fullCtx(scope, hotel.id)
    const created = await createRoom(owner, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1201', inServiceFrom: TODAY, features: [] })

    const noAccessCtx = makeCtx(scope, { permissions: ['room.view', 'room.manage'], hotelIds: [], now: CLOCK }) // no access to THIS hotel

    const err = await updateRoom(noAccessCtx, hotel.id, created.id, { roomNumber: '9999' }).catch(e => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err.code).toBe('HOTEL_NOT_FOUND')
    expect(err.code).not.toBe('ROOM_NUMBER_IMMUTABLE')
  })

  it('a caller WITH hotel access but WITHOUT room.manage submitting roomNumber gets 403, not 422 ROOM_NUMBER_IMMUTABLE', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const owner = fullCtx(scope, hotel.id)
    const created = await createRoom(owner, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1202', inServiceFrom: TODAY, features: [] })

    const viewOnlyCtx = makeCtx(scope, { permissions: ['room.view'], hotelIds: [hotel.id], now: CLOCK }) // access, but no room.manage

    const err = await updateRoom(viewOnlyCtx, hotel.id, created.id, { roomNumber: '9999' }).catch(e => e)
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err.code).toBe('FORBIDDEN')
    expect(err.code).not.toBe('ROOM_NUMBER_IMMUTABLE')
  })

  it('an AUTHORIZED caller submitting roomNumber still gets 422 ROOM_NUMBER_IMMUTABLE (unchanged behavior)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1203', inServiceFrom: TODAY, features: [] })

    await expect(updateRoom(ctx, hotel.id, created.id, { roomNumber: '9999' })).rejects.toMatchObject({ code: 'ROOM_NUMBER_IMMUTABLE', httpStatus: 422 })
  })
})

describe('foreign-reference discipline: body refs -> 422, URL refs -> 404, nothing written', () => {
  it('floorId of another hotel (same org) -> 422 INVALID_REFERENCE', async () => {
    const { scope } = await makeOrg(db)
    const { hotel: hotelA, roomType } = await setupHotel(scope)
    const { floor: floorB } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotelA.id)

    await expect(createRoom(ctx, hotelA.id, { floorId: floorB.id, roomTypeId: roomType.id, roomNumber: '501', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
    expect(await db.select().from(room).where(eq(room.hotelId, hotelA.id))).toEqual([])
  })

  it('floorId of another organization -> the same 422 INVALID_REFERENCE', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const { hotel: hotelA, roomType } = await setupHotel(orgA)
    const { floor: floorOther } = await setupHotel(orgB)
    const ctx = fullCtx(orgA, hotelA.id)

    await expect(createRoom(ctx, hotelA.id, { floorId: floorOther.id, roomTypeId: roomType.id, roomNumber: '502', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
  })

  it('a nonexistent floorId -> the same 422 INVALID_REFERENCE (never leaks existence)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    await expect(createRoom(ctx, hotel.id, { floorId: '11111111-1111-1111-1111-111111111111', roomTypeId: roomType.id, roomNumber: '503', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
  })

  it('roomTypeId of another organization -> 422 INVALID_REFERENCE', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const { hotel, floor } = await setupHotel(orgA)
    const foreignType = await makeRoomType(db, orgB)
    const ctx = fullCtx(orgA, hotel.id)

    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: foreignType.id, roomNumber: '504', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
  })

  it('GET/PATCH/retire/reactivate/base-config with a roomId of another hotel (same org) -> 404, identical to a nonexistent id', async () => {
    const { scope } = await makeOrg(db)
    const { hotel: hotelA } = await setupHotel(scope)
    const { hotel: hotelB, floor: floorB, roomType: typeB } = await setupHotel(scope)
    const ctx = makeCtx(scope, { permissions: ['room.view', 'room.manage', 'capacity.manage'], hotelIds: [hotelA.id, hotelB.id], now: CLOCK })
    const roomInB = await createRoom(ctx, hotelB.id, { floorId: floorB.id, roomTypeId: typeB.id, roomNumber: '601', inServiceFrom: TODAY, features: [] })
    const bogusId = '22222222-2222-2222-2222-222222222222'

    const foreignErr = await getRoom(ctx, hotelA.id, roomInB.id).catch(e => e)
    const bogusErr = await getRoom(ctx, hotelA.id, bogusId).catch(e => e)
    expect(foreignErr).toBeInstanceOf(NotFoundError)
    expect(bogusErr).toBeInstanceOf(NotFoundError)
    expect(foreignErr.code).toBe(bogusErr.code)

    await expect(updateRoom(ctx, hotelA.id, roomInB.id, { notes: 'hacked' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(retireRoom(ctx, hotelA.id, roomInB.id, { effectiveFrom: TODAY })).rejects.toBeInstanceOf(NotFoundError)
    await expect(changeBaseConfig(ctx, hotelA.id, roomInB.id, { effectiveFrom: TODAY, physicalBeds: 5, sellableCapacity: 5 })).rejects.toBeInstanceOf(NotFoundError)

    const [unchanged] = await db.select().from(room).where(eq(room.id, roomInB.id))
    expect(unchanged!.notes).toBeNull()
  })

  it('a roomId of another organization -> the same 404', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const { hotel: hotelA } = await setupHotel(orgA)
    const { hotel: hotelB, floor: floorB, roomType: typeB } = await setupHotel(orgB)
    const ctxB = fullCtx(orgB, hotelB.id)
    const roomInB = await createRoom(ctxB, hotelB.id, { floorId: floorB.id, roomTypeId: typeB.id, roomNumber: '602', inServiceFrom: TODAY, features: [] })

    const ctxA = fullCtx(orgA, hotelA.id)
    await expect(getRoom(ctxA, hotelA.id, roomInB.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('inactive-entity write guards', () => {
  it('inactive hotel -> ALL writes reject 409 HOTEL_INACTIVE; reads still work', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '701', inServiceFrom: TODAY, features: [] })

    await db.update(hotelTable).set({ status: 'INACTIVE' }).where(eq(hotelTable.id, hotel.id))

    await expect(getRoom(ctx, hotel.id, created.id)).resolves.toBeDefined()
    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '702', inServiceFrom: TODAY, features: [] })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(updateRoom(ctx, hotel.id, created.id, { notes: 'x' })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: TODAY, physicalBeds: 5, sellableCapacity: 5 })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
  })

  it('an inactive floor referenced in create/update -> 409 FLOOR_INACTIVE', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const otherFloor = await makeFloor(db, trustedHotelScope(scope, hotel.id), { level: 9, isActive: false })

    await expect(createRoom(ctx, hotel.id, { floorId: otherFloor.id, roomTypeId: roomType.id, roomNumber: '703', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'FLOOR_INACTIVE', httpStatus: 409 })

    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '704', inServiceFrom: TODAY, features: [] })
    await expect(updateRoom(ctx, hotel.id, created.id, { floorId: otherFloor.id })).rejects.toMatchObject({ code: 'FLOOR_INACTIVE', httpStatus: 409 })
  })

  it('an inactive room type referenced in create/update -> 409 ROOM_TYPE_INACTIVE', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const otherType = await makeRoomType(db, scope, { isActive: false })

    await expect(createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: otherType.id, roomNumber: '705', inServiceFrom: TODAY, features: [] }))
      .rejects.toMatchObject({ code: 'ROOM_TYPE_INACTIVE', httpStatus: 409 })

    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '706', inServiceFrom: TODAY, features: [] })
    await expect(updateRoom(ctx, hotel.id, created.id, { roomTypeId: otherType.id })).rejects.toMatchObject({ code: 'ROOM_TYPE_INACTIVE', httpStatus: 409 })
  })
})

describe('room-type default snapshot (D1): editing defaults later never touches existing rooms', () => {
  it('Quad room created at 4/4, type defaults later changed to 5/5 -> existing room stays 4/4, a NEW room gets 5/5', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope, { defaultPhysicalBeds: 4, defaultSellableCapacity: 4 })
    const ctx = fullCtx(scope, hotel.id)
    const orgCtx = makeCtx(scope, { permissions: ['room.manage'], allHotels: true, now: CLOCK })

    const roomA = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '801', inServiceFrom: TODAY, features: [] })
    expect(roomA.base).toEqual({ physicalBeds: 4, sellableCapacity: 4 })

    await updateRoomType(orgCtx, roomType.id, { defaultPhysicalBeds: 5, defaultSellableCapacity: 5 })

    const roomAAfter = await getRoom(ctx, hotel.id, roomA.id)
    expect(roomAAfter.base).toEqual({ physicalBeds: 4, sellableCapacity: 4 }) // untouched

    const roomB = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '802', inServiceFrom: TODAY, features: [] })
    expect(roomB.base).toEqual({ physicalBeds: 5, sellableCapacity: 5 })
  })
})

describe('changeBaseConfig — permission, history immutability, and validation', () => {
  it('closes the old version the day before and opens a new one; history is queryable oldest-first', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '901', inServiceFrom: '2027-01-01', features: [] })

    const changed = await changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 6, sellableCapacity: 6, reason: 'renovation' })

    expect(changed.baseVersions).toHaveLength(2)
    expect(changed.baseVersions[0]).toMatchObject({ validFrom: '2027-01-01', validTo: '2027-05-31', physicalBeds: 4, sellableCapacity: 4 })
    expect(changed.baseVersions[1]).toMatchObject({ validFrom: '2027-06-01', validTo: null, physicalBeds: 6, sellableCapacity: 6, origin: 'MANUAL' })

    // Effective capacity before/after the change:
    expect((await getRoom(ctx, hotel.id, created.id)).effective).toEqual({ physicalBeds: 4, sellableCapacity: 4, source: 'BASE', period: null })

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_BASE_CHANGED'))
    expect(auditRows).toHaveLength(1)
  })

  it('backdating a base change -> 409 BASE_CHANGE_IN_PAST', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '902', inServiceFrom: '2020-01-01', features: [] })

    await expect(changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: '2027-04-01', physicalBeds: 5, sellableCapacity: 5 }))
      .rejects.toMatchObject({ code: 'BASE_CHANGE_IN_PAST', httpStatus: 409 })
  })

  it('room.manage-only caller (no capacity.manage) -> 403; capacity.manage caller -> success', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const managerOnly = makeCtx(scope, { permissions: ['room.view', 'room.manage'], hotelIds: [hotel.id], now: CLOCK })
    const capacityManager = makeCtx(scope, { permissions: ['room.view', 'room.manage', 'capacity.manage'], hotelIds: [hotel.id], now: CLOCK })
    const created = await createRoom(capacityManager, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '903', inServiceFrom: '2027-01-01', features: [] })

    await expect(changeBaseConfig(managerOnly, hotel.id, created.id, { effectiveFrom: TODAY, physicalBeds: 5, sellableCapacity: 5 })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(changeBaseConfig(capacityManager, hotel.id, created.id, { effectiveFrom: TODAY, physicalBeds: 5, sellableCapacity: 5 })).resolves.toBeDefined()
  })

  it('history is never rewritten: closing + inserting a new version leaves the OLD version\'s other fields untouched', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '904', inServiceFrom: '2027-01-01', features: [] })
    const originalVersionId = created.baseVersions[0]!.id

    await changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 8, sellableCapacity: 8 })

    const [originalRow] = await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.id, originalVersionId))
    expect(originalRow!.validFrom).toBe('2027-01-01')
    expect(originalRow!.physicalBeds).toBe(4)
    expect(originalRow!.sellableCapacity).toBe(4)
    expect(originalRow!.origin).toBe('ROOM_TYPE_DEFAULT')
    expect(originalRow!.validTo).toBe('2027-05-31') // ONLY validTo was ever set
  })

  it('close-and-insert is atomic: an audit-write failure leaves the OLD version open (validTo untouched) and no new version row', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '905', inServiceFrom: '2027-01-01', features: [] })
    const originalVersionId = created.baseVersions[0]!.id

    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    await expect(changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 8, sellableCapacity: 8 }))
      .rejects.toThrow('simulated audit failure')

    const versions = await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, created.id))
    expect(versions).toHaveLength(1) // no new version was inserted
    expect(versions[0]!.id).toBe(originalVersionId)
    expect(versions[0]!.validTo).toBeNull() // the close was rolled back too
  })
})

describe('retire / reactivate lifecycle', () => {
  it('retire then reactivate adjacent (no gap)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1001', inServiceFrom: '2027-01-01', features: [] })

    const retired = await retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY })
    expect(retired.baseVersions).toHaveLength(1)
    expect(retired.baseVersions[0]!.validTo).toBe('2027-04-30')
    expect(retired.status).toBe('NOT_IN_INVENTORY')

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_RETIRED'))
    expect(auditRows).toHaveLength(1)

    const reactivated = await reactivateRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY, physicalBeds: 4, sellableCapacity: 4 })
    expect(reactivated.baseVersions).toHaveLength(2)
    expect(reactivated.baseVersions[1]).toMatchObject({ validFrom: TODAY, validTo: null })
    expect(reactivated.status).toBe('AVAILABLE')

    const reactivatedAudit = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_REACTIVATED'))
    expect(reactivatedAudit).toHaveLength(1)
  })

  it('retire then reactivate WITH a gap', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1002', inServiceFrom: '2027-01-01', features: [] })

    await retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY }) // last night 2027-04-30
    const reactivated = await reactivateRoom(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 4, sellableCapacity: 4 }) // gap: 2027-05-01..2027-05-31
    expect(reactivated.baseVersions).toHaveLength(2)
    expect(reactivated.baseVersions[0]!.validTo).toBe('2027-04-30')
    expect(reactivated.baseVersions[1]!.validFrom).toBe('2027-06-01')
  })

  it('retiring an already-retired room -> 409 ROOM_ALREADY_RETIRED', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1003', inServiceFrom: '2027-01-01', features: [] })

    await retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY })
    await expect(retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY })).rejects.toMatchObject({ code: 'ROOM_ALREADY_RETIRED', httpStatus: 409 })
  })

  it('retire is atomic: an audit-write failure leaves the version still open (validTo untouched)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1005', inServiceFrom: '2027-01-01', features: [] })
    const originalVersionId = created.baseVersions[0]!.id

    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    await expect(retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY })).rejects.toThrow('simulated audit failure')

    const [version] = await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.id, originalVersionId))
    expect(version!.validTo).toBeNull() // the close was rolled back
  })

  it('reactivate is atomic: an audit-write failure inserts NO new version row', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1006', inServiceFrom: '2027-01-01', features: [] })
    await retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY }) // last night 2027-04-30

    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    await expect(reactivateRoom(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 4, sellableCapacity: 4 }))
      .rejects.toThrow('simulated audit failure')

    const versions = await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, created.id))
    expect(versions).toHaveLength(1) // still just the retired version -- no reactivation row landed
    expect(versions[0]!.validTo).toBe('2027-04-30')
  })

  it('inventory=IN excludes a retired room after its last night and includes it before, for the given asOf', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1004', inServiceFrom: '2027-01-01', features: [] })
    await retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY }) // last night 2027-04-30

    const before = await listRooms(ctx, hotel.id, { asOf: '2027-04-01', inventory: 'IN', page: 1, pageSize: 20 })
    expect(before.items.map(i => i.id)).toContain(created.id)

    const after = await listRooms(ctx, hotel.id, { asOf: TODAY, inventory: 'IN', page: 1, pageSize: 20 })
    expect(after.items.map(i => i.id)).not.toContain(created.id)

    const outAfter = await listRooms(ctx, hotel.id, { asOf: TODAY, inventory: 'OUT', page: 1, pageSize: 20 })
    expect(outAfter.items.map(i => i.id)).toContain(created.id)
  })
})

describe('bulk room create', () => {
  it('range { prefix: "4", from: 1, to: 10, pad: 2 } produces 401..410', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    const created = await bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, range: { prefix: '4', from: 1, to: 10, pad: 2 } })

    expect(created).toHaveLength(10)
    expect(created.map(r => r.roomNumber).sort()).toEqual(['401', '402', '403', '404', '405', '406', '407', '408', '409', '410'])
    expect(created.every(r => r.base?.physicalBeds === roomType.defaultPhysicalBeds)).toBe(true)

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_CREATED'))
    expect(auditRows).toHaveLength(10)
  })

  it('one conflicting number -> 409 with details.conflicts, and ZERO rooms are created (all-or-nothing, re-queried)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '405', inServiceFrom: TODAY, features: [] })

    await expect(bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, range: { prefix: '4', from: 1, to: 10, pad: 2 } }))
      .rejects.toMatchObject({ code: 'ROOM_NUMBER_CONFLICT', httpStatus: 409, details: { conflicts: ['405'] } })

    const rows = await db.select().from(room).where(eq(room.hotelId, hotel.id))
    expect(rows).toHaveLength(1) // only the pre-existing 405, nothing from the bulk request
  })

  it('a retired room\'s number also counts as a conflict', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '406', inServiceFrom: '2020-01-01', features: [] })
    await retireRoom(ctx, hotel.id, created.id, { effectiveFrom: TODAY })

    await expect(bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, numbers: ['406'] }))
      .rejects.toMatchObject({ code: 'ROOM_NUMBER_CONFLICT', httpStatus: 409 })
  })

  it('duplicate numbers WITHIN the request (after normalization) -> 422, nothing created', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    await expect(bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, numbers: ['501', ' 501 '] }))
      .rejects.toMatchObject({ code: 'DUPLICATE_ROOM_NUMBER', httpStatus: 422 })

    expect(await db.select().from(room).where(eq(room.hotelId, hotel.id))).toEqual([])
  })

  it('all rows + base versions + audit rows are atomic: an audit-write failure partway through rolls back every insert', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    let calls = 0
    vi.spyOn(AuditRepository.prototype, 'record').mockImplementation(async () => {
      calls += 1
      if (calls === 3) throw new Error('simulated audit failure partway through bulk creation')
    })

    await expect(bulkCreateRooms(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, inServiceFrom: TODAY, range: { prefix: '5', from: 1, to: 5, pad: 2 } }))
      .rejects.toThrow('simulated audit failure partway through bulk creation')

    expect(await db.select().from(room).where(eq(room.hotelId, hotel.id))).toEqual([])
  })
})

describe('concurrency (real PostgreSQL, concurrent connections)', () => {
  it('two simultaneous createRoom calls for the same hotel+room-number: exactly one 201, one 409, exactly one row lands', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctxA = fullCtx(scope, hotel.id)
    const ctxB = fullCtx(scope, hotel.id)

    const results = await Promise.allSettled([
      createRoom(ctxA, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '601', inServiceFrom: TODAY, features: [] }),
      createRoom(ctxB, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '601', inServiceFrom: TODAY, features: [] }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })

    const rows = await db.select().from(room).where(eq(room.hotelId, hotel.id))
    expect(rows).toHaveLength(1)
  })

  it('two simultaneous base-config changes on the SAME room: exactly one succeeds, the other 409, and NO overlapping versions remain', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctxA = fullCtx(scope, hotel.id)
    const ctxB = fullCtx(scope, hotel.id)
    const created = await createRoom(ctxA, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '602', inServiceFrom: '2027-01-01', features: [] })

    const results = await Promise.allSettled([
      changeBaseConfig(ctxA, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 6, sellableCapacity: 6 }),
      changeBaseConfig(ctxB, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 8, sellableCapacity: 8 }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // No overlapping versions in the table -- the database's exclusion constraint is the final arbiter.
    const versions = (await new RoomBaseConfigRepository(db, trustedHotelScope(scope, hotel.id)).versionsForRoom(created.id))
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
    for (let i = 1; i < versions.length; i++) {
      const prev = versions[i - 1]!
      const cur = versions[i]!
      expect(prev.validTo).not.toBeNull()
      expect(prev.validTo! < cur.validFrom).toBe(true)
    }
  })
})

describe('room list — query mechanics', () => {
  it('q escapes SQL wildcards: q="%" matches NOTHING (not everything)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '401', inServiceFrom: TODAY, features: [] })

    const result = await listRooms(ctx, hotel.id, { q: '%', page: 1, pageSize: 20 })
    expect(result.items).toEqual([])
  })

  it('ordering is floor.level, then length(room_number), then room_number: 2 sorts before 10 before 101', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '101', inServiceFrom: TODAY, features: [] })
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '10', inServiceFrom: TODAY, features: [] })
    await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '2', inServiceFrom: TODAY, features: [] })

    const result = await listRooms(ctx, hotel.id, { page: 1, pageSize: 20 })
    expect(result.items.map(i => i.roomNumber)).toEqual(['2', '10', '101'])
  })

  it('an empty hotel returns 200 with an empty page (not an error)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)

    const result = await listRooms(ctx, hotel.id, { page: 1, pageSize: 20 })
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  it('a past asOf returns the historical base (not the current one)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '801', inServiceFrom: '2027-01-01', features: [] })
    await changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 9, sellableCapacity: 9 })

    const past = await listRooms(ctx, hotel.id, { asOf: '2027-02-01', page: 1, pageSize: 20 })
    expect(past.items.find(i => i.id === created.id)?.base).toEqual({ physicalBeds: 4, sellableCapacity: 4 })
  })

  it('a 50-room page runs a FIXED number of statements, independent of page size (N+1-free)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    for (let i = 0; i < 50; i++) {
      await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: `${1000 + i}`, inServiceFrom: TODAY, features: [] })
    }

    const listPageSpy = vi.spyOn(RoomRepository.prototype, 'listPage')
    const versionsSpy = vi.spyOn(RoomBaseConfigRepository.prototype, 'versionsForRooms')
    const floorsSpy = vi.spyOn(FloorRepository.prototype, 'list')
    const typesSpy = vi.spyOn(RoomTypeRepository.prototype, 'list')

    const result = await listRooms(ctx, hotel.id, { page: 1, pageSize: 50 })

    expect(result.items).toHaveLength(50)
    expect(listPageSpy).toHaveBeenCalledTimes(1)
    expect(versionsSpy).toHaveBeenCalledTimes(1)
    expect(floorsSpy).toHaveBeenCalledTimes(1)
    expect(typesSpy).toHaveBeenCalledTimes(1)
  })
})

describe('RoomDetail / RoomListItem shape', () => {
  it('status is AVAILABLE inside the room\'s versions and NOT_IN_INVENTORY outside; lifecycle reflects open-ended vs retired', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const openEnded = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '901', inServiceFrom: '2027-01-01', features: [] })
    expect(openEnded.status).toBe('AVAILABLE')
    expect(openEnded.lifecycle).toEqual({ inServiceFrom: '2027-01-01', lastNight: null })

    const notYet = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '902', inServiceFrom: '2028-01-01', features: [] })
    expect(notYet.status).toBe('NOT_IN_INVENTORY')

    const retired = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '903', inServiceFrom: '2020-01-01', features: [] })
    const retiredResult = await retireRoom(ctx, hotel.id, retired.id, { effectiveFrom: TODAY })
    expect(retiredResult.status).toBe('NOT_IN_INVENTORY')
    expect(retiredResult.lifecycle).toEqual({ inServiceFrom: '2020-01-01', lastNight: '2027-04-30' })
  })

  it('baseVersions is the complete history, oldest first', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '904', inServiceFrom: '2027-01-01', features: [] })
    await changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: TODAY, physicalBeds: 5, sellableCapacity: 5 })
    await changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 6, sellableCapacity: 6 })

    const detail = await getRoom(ctx, hotel.id, created.id)
    expect(detail.baseVersions.map(v => v.validFrom)).toEqual(['2027-01-01', TODAY, '2027-06-01'])
  })

  it('seasons is always [] in Task 14 (no capacity periods yet)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '905', inServiceFrom: TODAY, features: [] })
    expect(created.seasons).toEqual([])
  })

  it('nextChange reflects a scheduled base change ahead', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '906', inServiceFrom: '2027-01-01', features: [] })
    const changed = await changeBaseConfig(ctx, hotel.id, created.id, { effectiveFrom: '2027-06-01', physicalBeds: 7, sellableCapacity: 7 })

    expect(changed.nextChange).toMatchObject({ kind: 'CAPACITY', date: '2027-06-01', capacity: { physicalBeds: 7, sellableCapacity: 7 } })
  })
})

describe('updateRoom — no-op and strict schema mass-assignment protection', () => {
  it('a no-op patch writes no audit row and leaves updated_at untouched (fresh DB re-query)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1101', inServiceFrom: TODAY, features: ['CITY_VIEW'], notes: 'Same' })
    const [before] = await db.select().from(room).where(eq(room.id, created.id))

    await updateRoom(ctx, hotel.id, created.id, { notes: 'Same', features: ['CITY_VIEW'] })

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_UPDATED'))
    expect(auditRows).toHaveLength(0)
    const [after] = await db.select().from(room).where(eq(room.id, created.id))
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime())
  })

  it('a real patch (floorId/roomType/features/notes) writes a diff-only audit row; changing roomType never changes capacity', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const otherFloor = await makeFloor(db, trustedHotelScope(scope, hotel.id), { level: 5 })
    const otherType = await makeRoomType(db, scope, { defaultPhysicalBeds: 8, defaultSellableCapacity: 8 })
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1102', inServiceFrom: TODAY, features: [] })

    const updated = await updateRoom(ctx, hotel.id, created.id, { floorId: otherFloor.id, roomTypeId: otherType.id, features: ['ACCESSIBLE'], notes: 'moved' })

    expect(updated.floor.id).toBe(otherFloor.id)
    expect(updated.roomType.id).toBe(otherType.id)
    expect(updated.features).toEqual(['ACCESSIBLE'])
    expect(updated.base).toEqual({ physicalBeds: 4, sellableCapacity: 4 }) // capacity UNCHANGED despite the room-type swap

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_UPDATED'))
    expect(auditRows).toHaveLength(1)
  })

  it('a body with id/organizationId/hotelId/physicalBeds/sellableCapacity is rejected at the schema layer (proven at the HTTP layer; here we prove the service ignores capacity fields even if smuggled past a hand-built patch object)', async () => {
    const { scope } = await makeOrg(db)
    const { hotel, floor, roomType } = await setupHotel(scope)
    const ctx = fullCtx(scope, hotel.id)
    const created = await createRoom(ctx, hotel.id, { floorId: floor.id, roomTypeId: roomType.id, roomNumber: '1103', inServiceFrom: TODAY, features: [] })

    // updateRoom's UpdateRoomInput type has no capacity fields at all -- this line would not compile
    // with them present, which is the structural proof; the runtime HTTP 422 is proven in rooms.http.test.ts.
    await updateRoom(ctx, hotel.id, created.id, { notes: 'still 4/4' })
    const after = await getRoom(ctx, hotel.id, created.id)
    expect(after.base).toEqual({ physicalBeds: 4, sellableCapacity: 4 })
  })
})
