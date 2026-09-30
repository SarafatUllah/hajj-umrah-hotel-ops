import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLog, roomType } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { ForbiddenError, NotFoundError } from '../../../server/errors/domainError'
import { AuditRepository, RoomTypeRepository } from '../../../server/repositories/tenant'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import type { Permission } from '../../../shared/constants/permissions'
import {
  activateRoomType,
  createRoomType,
  deactivateRoomType,
  listRoomTypes,
  updateRoomType,
} from '../../../server/services/roomTypeService'
import { makeOrg, makeRoomType, makeUser } from '../../support/fixtures'
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

// defaultPhysicalBeds/defaultSellableCapacity have no DB-level default (only shared/schemas/roomType.ts's
// Zod schema applies 4/4) — these tests call the service directly, bypassing route-level Zod parsing,
// so they must supply both explicitly (an HTTP-level test proves the schema's own defaults separately).
const VALID_CREATE = { code: 'STD-01', name: 'Standard Room', defaultPhysicalBeds: 4, defaultSellableCapacity: 4 } as const

describe('createRoomType — authorization matrix and defaults', () => {
  it('room.manage + allHotels -> creates the room type and a ROOM_TYPE_CREATED audit row with hotel_id null', async () => {
    const { scope } = await makeOrg(db)
    const actor = await makeUser(db, scope)
    const ctx = makeCtx(scope, { userId: actor.id, permissions: ['room.manage'], allHotels: true })

    const created = await createRoomType(ctx, VALID_CREATE)
    expect(created.defaultPhysicalBeds).toBe(4)
    expect(created.defaultSellableCapacity).toBe(4)
    expect(created.isActive).toBe(true)
    expect(created.usageCount).toBeNull()

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_TYPE_CREATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.hotelId).toBeNull()
    expect(auditRows[0]!.entityId).toBe(created.id)
    expect(auditRows[0]!.actorUserId).toBe(actor.id)
  })

  it('room.manage without allHotels (hotel-scoped manager) -> ForbiddenError', async () => {
    const { scope } = await makeOrg(db)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], allHotels: false })

    await expect(createRoomType(ctx, VALID_CREATE)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('missing room.manage entirely -> ForbiddenError', async () => {
    const { scope } = await makeOrg(db)
    const ctx = makeCtx(scope, { permissions: ['room.view'], allHotels: true })

    await expect(createRoomType(ctx, VALID_CREATE)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('a hotel-scoped user with room.view can still list room types', async () => {
    const { scope } = await makeOrg(db)
    await makeRoomType(db, scope)
    const ctx = makeCtx(scope, { permissions: ['room.view'], allHotels: false, hotelIds: [] })

    await expect(listRoomTypes(ctx, {})).resolves.toHaveLength(1)
  })

  it('sellable capacity greater than physical beds is ACCEPTED (create actually succeeds)', async () => {
    const { scope } = await makeOrg(db)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], allHotels: true })

    const created = await createRoomType(ctx, { ...VALID_CREATE, code: 'XTRA-01', defaultPhysicalBeds: 4, defaultSellableCapacity: 6 })
    expect(created.defaultPhysicalBeds).toBe(4)
    expect(created.defaultSellableCapacity).toBe(6)
  })
})

describe('createRoomType — duplicate code', () => {
  it('rejects a duplicate code within the same organization as 409 ALREADY_EXISTS, but allows it in another organization', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const ctxA = makeCtx(orgA, { permissions: ['room.manage'], allHotels: true })
    const ctxB = makeCtx(orgB, { permissions: ['room.manage'], allHotels: true })

    await createRoomType(ctxA, { ...VALID_CREATE, code: 'DUPE-RT' })

    await expect(createRoomType(ctxA, { ...VALID_CREATE, code: 'DUPE-RT' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })
    await expect(createRoomType(ctxB, { ...VALID_CREATE, code: 'DUPE-RT' })).resolves.toBeDefined()
  })
})

describe('foreign-org id: update/activate/deactivate -> 404, indistinguishable from nonexistent', () => {
  it('a room type from another organization -> 404 on update/activate/deactivate', async () => {
    const { scope: org } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const foreignType = await makeRoomType(db, otherOrg)
    const ctx = makeCtx(org, { permissions: ['room.manage'], allHotels: true })

    let foreignError: unknown
    let bogusError: unknown
    try { await updateRoomType(ctx, foreignType.id, { name: 'Hacked' }) } catch (e) { foreignError = e }
    try { await updateRoomType(ctx, '11111111-1111-1111-1111-111111111111', { name: 'Hacked' }) } catch (e) { bogusError = e }

    expect(foreignError).toBeInstanceOf(NotFoundError)
    expect(bogusError).toBeInstanceOf(NotFoundError)
    expect((foreignError as NotFoundError).code).toBe((bogusError as NotFoundError).code)

    await expect(activateRoomType(ctx, foreignType.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(deactivateRoomType(ctx, foreignType.id)).rejects.toBeInstanceOf(NotFoundError)

    const [unchanged] = await db.select().from(roomType).where(eq(roomType.id, foreignType.id))
    expect(unchanged!.name).not.toBe('Hacked')
  })
})

describe('updateRoomType — full lifecycle, diff-only audit, and no-op', () => {
  it('patch, deactivate, activate, no-op, and correct audits at each step', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeRoomType(db, scope, { name: 'Old Name' })
    const ctx = makeCtx(scope, { permissions: ['room.manage'], allHotels: true })

    const updated = await updateRoomType(ctx, target.id, { name: 'New Name' })
    expect(updated.name).toBe('New Name')
    let auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_TYPE_UPDATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.beforeData).toEqual({ name: 'Old Name' })
    expect(auditRows[0]!.afterData).toEqual({ name: 'New Name' })
    expect(auditRows[0]!.hotelId).toBeNull()

    // No-op: submitting the identical value writes no new audit row AND leaves updated_at untouched.
    // Captured via fresh DB re-queries (not the value returned by the prior update call) so this proves
    // no UPDATE statement ran at all, not merely that the audit count didn't increase.
    const [beforeNoOp] = await db.select().from(roomType).where(eq(roomType.id, target.id))
    await updateRoomType(ctx, target.id, { name: 'New Name' })
    auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'ROOM_TYPE_UPDATED'))
    expect(auditRows).toHaveLength(1)
    const [afterNoOp] = await db.select().from(roomType).where(eq(roomType.id, target.id))
    expect(afterNoOp!.updatedAt.getTime()).toBe(beforeNoOp!.updatedAt.getTime())

    const deactivated = await deactivateRoomType(ctx, target.id)
    expect(deactivated.isActive).toBe(false)
    await expect(deactivateRoomType(ctx, target.id)).rejects.toMatchObject({ code: 'ROOM_TYPE_ALREADY_INACTIVE', httpStatus: 409 })

    const activated = await activateRoomType(ctx, target.id)
    expect(activated.isActive).toBe(true)
    await expect(activateRoomType(ctx, target.id)).rejects.toMatchObject({ code: 'ROOM_TYPE_ALREADY_ACTIVE', httpStatus: 409 })
  })

  it('editing defaults or deactivating a type never touches any other row (only the room_type row itself is written)', async () => {
    const { scope } = await makeOrg(db)
    const other = await makeRoomType(db, scope, { name: 'Untouched' })
    const target = await makeRoomType(db, scope, { name: 'Target' })
    const ctx = makeCtx(scope, { permissions: ['room.manage'], allHotels: true })

    await updateRoomType(ctx, target.id, { defaultPhysicalBeds: 6 })
    await deactivateRoomType(ctx, target.id)

    const [untouched] = await db.select().from(roomType).where(eq(roomType.id, other.id))
    expect(untouched!.name).toBe('Untouched')
    expect(untouched!.isActive).toBe(true)
  })
})

describe('createRoomType — validation boundaries surfaced at the service (real DB round-trip)', () => {
  it('beds 0 and 31 are rejected by the check constraint if a caller bypasses the schema (defensive DB-level proof)', async () => {
    const { scope } = await makeOrg(db)
    await expect(new RoomTypeRepository(db, scope).insert({ code: 'BAD-01', name: 'Bad', defaultPhysicalBeds: 0, defaultSellableCapacity: 4 })).rejects.toBeDefined()
    await expect(new RoomTypeRepository(db, scope).insert({ code: 'BAD-02', name: 'Bad', defaultPhysicalBeds: 31, defaultSellableCapacity: 4 })).rejects.toBeDefined()
  })
})

describe('room type audit atomicity', () => {
  it('rolls back the room_type insert when the audit write fails', async () => {
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    const { scope } = await makeOrg(db)
    const ctx = makeCtx(scope, { permissions: ['room.manage'], allHotels: true })

    await expect(createRoomType(ctx, VALID_CREATE)).rejects.toThrow('simulated audit failure')

    const rows = await db.select().from(roomType).where(eq(roomType.organizationId, scope.organizationId))
    expect(rows).toEqual([])
  })
})
