import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLog, floor } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { ForbiddenError, NotFoundError } from '../../../server/errors/domainError'
import { AuditRepository } from '../../../server/repositories/tenant'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import type { Permission } from '../../../shared/constants/permissions'
import {
  activateFloor,
  bulkCreateFloors,
  createFloor,
  deactivateFloor,
  listFloors,
  updateFloor,
} from '../../../server/services/floorService'
import { makeFloor, makeHotel, makeOrg, makeUser } from '../../support/fixtures'
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

describe('createFloor — authorization and default labels', () => {
  it('room.manage -> creates the floor and a FLOOR_CREATED audit row with hotel_id set', async () => {
    const { scope } = await makeOrg(db)
    const actor = await makeUser(db, scope)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { userId: actor.id, permissions: ['room.manage'], hotelIds: [target.id] })

    const created = await createFloor(ctx, target.id, { level: 5, label: 'My Floor' })
    expect(created.level).toBe(5)
    expect(created.label).toBe('My Floor')
    expect(created.isActive).toBe(true)
    expect(created.roomCount).toBe(0)

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'FLOOR_CREATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.hotelId).toBe(target.id)
    expect(auditRows[0]!.entityId).toBe(created.id)
    expect(auditRows[0]!.beforeData).toBeNull()
    expect(auditRows[0]!.actorUserId).toBe(actor.id)
  })

  it('default label is "Ground" for level 0', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    const created = await createFloor(ctx, target.id, { level: 0 })
    expect(created.label).toBe('Ground')
  })

  it.each([[-5, 'Floor -5'], [1, 'Floor 1'], [12, 'Floor 12']])('default label for level %i is "%s"', async (level, expectedLabel) => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    const created = await createFloor(ctx, target.id, { level })
    expect(created.label).toBe(expectedLabel)
  })

  it('missing room.manage -> ForbiddenError', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.view'], hotelIds: [target.id] })

    await expect(createFloor(ctx, target.id, { level: 1 })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('a duplicate level within the same hotel -> 409 ALREADY_EXISTS', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    await createFloor(ctx, target.id, { level: 3 })
    await expect(createFloor(ctx, target.id, { level: 3 })).rejects.toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })
  })
})

describe('bulkCreateFloors — atomicity and validation', () => {
  it('creates 13 floors for range 0..12 in one call, every level present with correct default labels', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    const created = await bulkCreateFloors(ctx, target.id, { fromLevel: 0, toLevel: 12 })
    expect(created).toHaveLength(13)
    expect(created.map(f => f.level).sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i))

    const ground = created.find(f => f.level === 0)
    expect(ground!.label).toBe('Ground')
    const five = created.find(f => f.level === 5)
    expect(five!.label).toBe('Floor 5')

    const rows = await db.select().from(floor).where(eq(floor.hotelId, target.id))
    expect(rows).toHaveLength(13)

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'FLOOR_CREATED'))
    expect(auditRows).toHaveLength(13)
    expect(auditRows.every(r => r.hotelId === target.id)).toBe(true)
  })

  it('one existing level -> 409 with details.existing, and NOTHING new is created (re-queried)', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    await createFloor(ctx, target.id, { level: 5 })

    await expect(bulkCreateFloors(ctx, target.id, { fromLevel: 0, toLevel: 12 })).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      httpStatus: 409,
      details: { existing: [5] },
    })

    // Only the single pre-existing floor remains — the bulk request created nothing.
    const rows = await db.select().from(floor).where(eq(floor.hotelId, target.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.level).toBe(5)
  })

  it('rolls back every insert AND every audit row when the audit write fails partway through (atomicity)', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    let calls = 0
    vi.spyOn(AuditRepository.prototype, 'record').mockImplementation(async () => {
      calls += 1
      if (calls === 3) throw new Error('simulated audit failure partway through bulk creation')
    })

    await expect(bulkCreateFloors(ctx, target.id, { fromLevel: 0, toLevel: 5 })).rejects.toThrow('simulated audit failure partway through bulk creation')

    // Every insert in the same transaction rolled back too — zero floor rows landed, not even the
    // ones whose audit write happened to succeed before the 3rd call threw.
    const rows = await db.select().from(floor).where(eq(floor.hotelId, target.id))
    expect(rows).toEqual([])
  })
})

describe('foreign-id isolation: PATCH/activate/deactivate a floor scoped to the wrong hotel', () => {
  it('a floor belonging to another hotel in the same org -> 404, no write', async () => {
    const { scope } = await makeOrg(db)
    const hotelA = await makeHotel(db, scope)
    const hotelB = await makeHotel(db, scope)
    const floorInB = await makeFloor(db, trustedHotelScope(scope, hotelB.id), { level: 1, label: 'Original' })
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [hotelA.id, hotelB.id] })

    await expect(updateFloor(ctx, hotelA.id, floorInB.id, { label: 'Hacked' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(activateFloor(ctx, hotelA.id, floorInB.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(deactivateFloor(ctx, hotelA.id, floorInB.id)).rejects.toBeInstanceOf(NotFoundError)

    const [unchanged] = await db.select().from(floor).where(eq(floor.id, floorInB.id))
    expect(unchanged!.label).toBe('Original')
    expect(unchanged!.isActive).toBe(true)
  })

  it('a floor belonging to another organization -> the same 404, no write', async () => {
    const { scope: org } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const hotelInOrg = await makeHotel(db, org)
    const hotelInOtherOrg = await makeHotel(db, otherOrg)
    const foreignFloor = await makeFloor(db, trustedHotelScope(otherOrg, hotelInOtherOrg.id), { level: 1, label: 'Original' })
    const ctx = makeCtx(org, { permissions: ['room.manage'], allHotels: true })

    // Same-org hotel id is authorized, but the floorId belongs to a hotel in a different org entirely.
    await expect(updateFloor(ctx, hotelInOrg.id, foreignFloor.id, { label: 'Hacked' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(activateFloor(ctx, hotelInOrg.id, foreignFloor.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(deactivateFloor(ctx, hotelInOrg.id, foreignFloor.id)).rejects.toBeInstanceOf(NotFoundError)

    const [unchanged] = await db.select().from(floor).where(eq(floor.id, foreignFloor.id))
    expect(unchanged!.label).toBe('Original')
  })

  it('a nonexistent floorId -> the same 404', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })
    const bogusId = '11111111-1111-1111-1111-111111111111'

    await expect(updateFloor(ctx, target.id, bogusId, { label: 'X' })).rejects.toBeInstanceOf(NotFoundError)
    await expect(activateFloor(ctx, target.id, bogusId)).rejects.toBeInstanceOf(NotFoundError)
    await expect(deactivateFloor(ctx, target.id, bogusId)).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('inactive hotel: reads succeed, every write rejects with 409 HOTEL_INACTIVE', () => {
  it('listFloors succeeds; create/bulk/update/activate/deactivate all reject', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { status: 'INACTIVE' })
    const existing = await makeFloor(db, trustedHotelScope(scope, target.id), { level: 1 })
    const ctx = makeCtx(scope, { permissions: ['room.view', 'room.manage'], hotelIds: [target.id] })

    await expect(listFloors(ctx, target.id, {})).resolves.toBeDefined()

    await expect(createFloor(ctx, target.id, { level: 2 })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(bulkCreateFloors(ctx, target.id, { fromLevel: 3, toLevel: 4 })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(updateFloor(ctx, target.id, existing.id, { label: 'X' })).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(activateFloor(ctx, target.id, existing.id)).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
    await expect(deactivateFloor(ctx, target.id, existing.id)).rejects.toMatchObject({ code: 'HOTEL_INACTIVE', httpStatus: 409 })
  })
})

describe('updateFloor — diff-only audit and no-op', () => {
  it('a no-op patch (submitted values equal current values) writes no audit row and leaves updated_at untouched', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const existing = await makeFloor(db, trustedHotelScope(scope, target.id), { level: 1, label: 'Same Label' })
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    const result = await updateFloor(ctx, target.id, existing.id, { label: 'Same Label' })
    expect(result.label).toBe('Same Label')

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'FLOOR_UPDATED'))
    expect(auditRows).toHaveLength(0)

    const [row] = await db.select().from(floor).where(eq(floor.id, existing.id))
    expect(row!.updatedAt.getTime()).toBe(existing.updatedAt.getTime())
  })

  it('a real patch writes before/after diff-only audit', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const existing = await makeFloor(db, trustedHotelScope(scope, target.id), { level: 1, label: 'Old Label' })
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    const updated = await updateFloor(ctx, target.id, existing.id, { label: 'New Label' })
    expect(updated.label).toBe('New Label')

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'FLOOR_UPDATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.beforeData).toEqual({ label: 'Old Label' })
    expect(auditRows[0]!.afterData).toEqual({ label: 'New Label' })
    expect(auditRows[0]!.hotelId).toBe(target.id)
  })
})

describe('activateFloor / deactivateFloor — lifecycle', () => {
  it('deactivate an active floor -> inactive + audit; a second deactivate -> 409 FLOOR_ALREADY_INACTIVE', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const existing = await makeFloor(db, trustedHotelScope(scope, target.id), { level: 1, isActive: true })
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    const deactivated = await deactivateFloor(ctx, target.id, existing.id)
    expect(deactivated.isActive).toBe(false)

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'FLOOR_UPDATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.beforeData).toEqual({ isActive: true })
    expect(auditRows[0]!.afterData).toEqual({ isActive: false })

    await expect(deactivateFloor(ctx, target.id, existing.id)).rejects.toMatchObject({ code: 'FLOOR_ALREADY_INACTIVE', httpStatus: 409 })
  })

  it('activate an inactive floor -> active + audit; a second activate -> 409 FLOOR_ALREADY_ACTIVE', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const existing = await makeFloor(db, trustedHotelScope(scope, target.id), { level: 1, isActive: false })
    const ctx = makeCtx(scope, { permissions: ['room.manage'], hotelIds: [target.id] })

    const activated = await activateFloor(ctx, target.id, existing.id)
    expect(activated.isActive).toBe(true)

    await expect(activateFloor(ctx, target.id, existing.id)).rejects.toMatchObject({ code: 'FLOOR_ALREADY_ACTIVE', httpStatus: 409 })
  })
})

describe('listFloors', () => {
  it('excludes inactive floors by default, includes them with includeInactive=true', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    await makeFloor(db, trustedHotelScope(scope, target.id), { level: 1, isActive: true })
    await makeFloor(db, trustedHotelScope(scope, target.id), { level: 2, isActive: false })
    const ctx = makeCtx(scope, { permissions: ['room.view'], hotelIds: [target.id] })

    const activeOnly = await listFloors(ctx, target.id, {})
    expect(activeOnly.map(f => f.level)).toEqual([1])

    const all = await listFloors(ctx, target.id, { includeInactive: true })
    expect(all.map(f => f.level).sort((a, b) => a - b)).toEqual([1, 2])
  })
})
