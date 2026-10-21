import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { appUser, auditLog, hotel } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { ForbiddenError, NotFoundError } from '../../../server/errors/domainError'
import { tenantRepos } from '../../../server/repositories'
import { AuditRepository, HotelRepository } from '../../../server/repositories/tenant'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import type { Permission } from '../../../shared/constants/permissions'
import {
  activateHotel,
  createHotel,
  deactivateHotel,
  getHotel,
  getSettings,
  listHotelAudit,
  listHotels,
  updateHotel,
  updateSettings,
} from '../../../server/services/hotelService'
import { auditCursorSchema } from '../../../shared/schemas/hotel'
import { makeFloor, makeHotel, makeOrg, makeRoomType, makeRoomWithVersion, makeUser } from '../../support/fixtures'
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

const VALID_CREATE = { code: 'HTL-01', name: 'Al Safwah', city: 'Makkah', timezone: 'Asia/Riyadh' } as const

/**
 * Direct insert (bypasses `AuditRepository#record`, which always defaults `created_at` to `now()`)
 * so pagination/ordering tests can force exact, deterministic `created_at` values — including
 * multiple rows sharing the exact same timestamp (Finding 3B's tie-ordering proof) and a
 * strictly-increasing sequence (Finding 2's no-skip proof). Scoped to this test file only.
 */
async function insertAuditRow(scope: OrganizationScope, opts: {
  hotelId: string
  createdAt: Date
  entityType?: string
  entityId?: string
  action?: string
}): Promise<{ id: string, createdAt: Date }> {
  const [row] = await db.insert(auditLog).values({
    organizationId: scope.organizationId,
    hotelId: opts.hotelId,
    entityType: opts.entityType ?? 'hotel',
    entityId: opts.entityId ?? opts.hotelId,
    action: opts.action ?? 'HOTEL_UPDATED',
    createdAt: opts.createdAt,
  }).returning({ id: auditLog.id, createdAt: auditLog.createdAt })
  return row!
}

describe('createHotel — authorization matrix', () => {
  it('allHotels + hotel.manage -> creates the hotel and a HOTEL_CREATED audit row with hotel_id = the new hotel', async () => {
    const { scope, organization } = await makeOrg(db)
    const actor = await makeUser(db, scope)
    const ctx = makeCtx(scope, { userId: actor.id, permissions: ['hotel.manage'], allHotels: true })

    const created = await createHotel(ctx, VALID_CREATE)
    expect(created.code).toBe('HTL-01')
    expect(created.status).toBe('ACTIVE')

    const rows = await db.select().from(hotel).where(eq(hotel.organizationId, organization.id))
    expect(rows).toHaveLength(1)

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'HOTEL_CREATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.hotelId).toBe(created.id)
    expect(auditRows[0]!.entityId).toBe(created.id)
    expect(auditRows[0]!.beforeData).toBeNull()
    expect(auditRows[0]!.actorUserId).toBe(actor.id)
  })

  it('hotel.manage without allHotels (hotel-scoped manager) -> ForbiddenError', async () => {
    const { scope } = await makeOrg(db)
    const someHotel = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], allHotels: false, hotelIds: [someHotel.id] })

    await expect(createHotel(ctx, { ...VALID_CREATE, code: 'HTL-02' })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('a role without hotel.manage -> ForbiddenError', async () => {
    const { scope } = await makeOrg(db)
    const ctx = makeCtx(scope, { permissions: ['hotel.view'], allHotels: true })

    await expect(createHotel(ctx, { ...VALID_CREATE, code: 'HTL-03' })).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('createHotel — duplicate code', () => {
  it('rejects a duplicate code within the same organization as 409 ALREADY_EXISTS, but allows it in another organization', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const ctxA = makeCtx(orgA, { permissions: ['hotel.manage'], allHotels: true })
    const ctxB = makeCtx(orgB, { permissions: ['hotel.manage'], allHotels: true })

    await createHotel(ctxA, { ...VALID_CREATE, code: 'DUPE' })

    await expect(createHotel(ctxA, { ...VALID_CREATE, code: 'DUPE' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })
    await expect(createHotel(ctxB, { ...VALID_CREATE, code: 'DUPE' })).resolves.toBeDefined()
  })
})

describe('listHotels — isolation', () => {
  it('a user with access to 2 of 5 hotels sees exactly those 2', async () => {
    const { scope } = await makeOrg(db)
    const hotels = await Promise.all(Array.from({ length: 5 }, (_, i) => makeHotel(db, scope, { code: `H${i}`, name: `Hotel ${i}` })))
    const ctx = makeCtx(scope, { permissions: ['hotel.view'], hotelIds: [hotels[0]!.id, hotels[2]!.id] })

    const result = await listHotels(ctx)
    expect(result.map(h => h.id).sort()).toEqual([hotels[0]!.id, hotels[2]!.id].sort())
  })

  it('an allHotels user sees all of their org\'s hotels and none of another org\'s', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    await makeHotel(db, orgA, { code: 'A1' })
    await makeHotel(db, orgA, { code: 'A2' })
    await makeHotel(db, orgB, { code: 'B1' })
    const ctx = makeCtx(orgA, { permissions: ['hotel.view'], allHotels: true })

    const result = await listHotels(ctx)
    expect(result).toHaveLength(2)
    expect(result.every(h => ['A1', 'A2'].includes(h.code))).toBe(true)
  })

  it('a user with no hotel access gets []', async () => {
    const { scope } = await makeOrg(db)
    await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['hotel.view'], hotelIds: [] })

    expect(await listHotels(ctx)).toEqual([])
  })

  it('returns hotels ordered by name', async () => {
    const { scope } = await makeOrg(db)
    await makeHotel(db, scope, { code: 'Z1', name: 'Zafran Hotel' })
    await makeHotel(db, scope, { code: 'A1', name: 'Al Safwah' })
    const ctx = makeCtx(scope, { permissions: ['hotel.view'], allHotels: true })

    const result = await listHotels(ctx)
    expect(result.map(h => h.name)).toEqual(['Al Safwah', 'Zafran Hotel'])
  })
})

describe('single-hotel access matrix (get/patch/activate/deactivate)', () => {
  it('foreign-org hotel id -> 404, identical to a same-org hotel the caller has no access to', async () => {
    const { scope: org } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrg)
    const ownHotel = await makeHotel(db, org)

    const ctxForeign = makeCtx(org, { permissions: ['hotel.view'], allHotels: true })
    const ctxNoAccess = makeCtx(org, { permissions: ['hotel.view'], hotelIds: [] })

    let foreignError: unknown
    let noAccessError: unknown
    try { await getHotel(ctxForeign, foreignHotel.id) } catch (e) { foreignError = e }
    try { await getHotel(ctxNoAccess, ownHotel.id) } catch (e) { noAccessError = e }

    expect(foreignError).toBeInstanceOf(NotFoundError)
    expect(noAccessError).toBeInstanceOf(NotFoundError)
    expect((foreignError as NotFoundError).code).toBe((noAccessError as NotFoundError).code)
    expect((noAccessError as NotFoundError).code).toBe('HOTEL_NOT_FOUND')
  })

  it('access but missing permission -> 403 (get, patch, activate, deactivate)', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { status: 'INACTIVE' })
    const ctxNoPerm = makeCtx(scope, { permissions: [], hotelIds: [target.id] })

    await expect(getHotel(ctxNoPerm, target.id)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(updateHotel(ctxNoPerm, target.id, { name: 'X' })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(activateHotel(ctxNoPerm, target.id)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(deactivateHotel(makeCtx(scope, { permissions: [], hotelIds: [target.id] }), target.id)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('patch/activate/deactivate on a foreign-org hotel -> the same 404 as get', async () => {
    const { scope: org } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrg)
    const ctx = makeCtx(org, { permissions: ['hotel.manage'], allHotels: true })

    await expect(updateHotel(ctx, foreignHotel.id, { name: 'X' })).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND' })
    await expect(activateHotel(ctx, foreignHotel.id)).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND' })
    await expect(deactivateHotel(ctx, foreignHotel.id)).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND' })
  })
})

describe('updateHotel — diff-only audit, no-op, and code immutability', () => {
  it('writes before/after of only the changed fields', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { name: 'Old Name', city: 'Jeddah' })
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], hotelIds: [target.id] })

    const updated = await updateHotel(ctx, target.id, { name: 'New Name' })
    expect(updated.name).toBe('New Name')
    expect(updated.city).toBe('Jeddah')

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'HOTEL_UPDATED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.beforeData).toEqual({ name: 'Old Name' })
    expect(auditRows[0]!.afterData).toEqual({ name: 'New Name' })
  })

  it('a no-op patch (submitted values equal current values) writes no audit row and leaves updated_at untouched', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { name: 'Same Name' })
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], hotelIds: [target.id] })

    const before = await updateHotel(ctx, target.id, { name: 'Same Name' })
    expect(before.updatedAt).toBe(target.updatedAt.toISOString())

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'HOTEL_UPDATED'))
    expect(auditRows).toHaveLength(0)

    const [row] = await db.select().from(hotel).where(eq(hotel.id, target.id))
    expect(row!.updatedAt.getTime()).toBe(target.updatedAt.getTime())
  })

  it('updateHotelSchema has no code field, so code can never be part of a patch (type-level immutability, exercised via the schema in unit tests)', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { code: 'ORIGINAL' })
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], hotelIds: [target.id] })

    const updated = await updateHotel(ctx, target.id, { name: 'Renamed' })
    expect(updated.code).toBe('ORIGINAL')
  })
})

describe('activateHotel / deactivateHotel — lifecycle', () => {
  it('deactivate an active hotel -> INACTIVE + audit; a second deactivate -> 409 ALREADY_INACTIVE', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { status: 'ACTIVE' })
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], hotelIds: [target.id] })

    const deactivated = await deactivateHotel(ctx, target.id)
    expect(deactivated.status).toBe('INACTIVE')

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'HOTEL_DEACTIVATED'))
    expect(auditRows).toHaveLength(1)

    await expect(deactivateHotel(ctx, target.id)).rejects.toMatchObject({ code: 'ALREADY_INACTIVE', httpStatus: 409 })
  })

  it('activate an inactive hotel -> ACTIVE + audit; a second activate -> 409 ALREADY_ACTIVE', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { status: 'INACTIVE' })
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], hotelIds: [target.id] })

    const activated = await activateHotel(ctx, target.id)
    expect(activated.status).toBe('ACTIVE')

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'HOTEL_ACTIVATED'))
    expect(auditRows).toHaveLength(1)

    await expect(activateHotel(ctx, target.id)).rejects.toMatchObject({ code: 'ALREADY_ACTIVE', httpStatus: 409 })
  })

  it('an inactive hotel still returns from getHotel and accepts updateHotel', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { status: 'INACTIVE', name: 'Old' })
    const ctx = makeCtx(scope, { permissions: ['hotel.view', 'hotel.manage'], hotelIds: [target.id] })

    const fetched = await getHotel(ctx, target.id)
    expect(fetched.status).toBe('INACTIVE')

    const updated = await updateHotel(ctx, target.id, { name: 'New' })
    expect(updated.name).toBe('New')
    expect(updated.status).toBe('INACTIVE')
  })
})

describe('hotel settings', () => {
  it('returns registry defaults when nothing is stored', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['hotel.view'], hotelIds: [target.id] })

    expect(await getSettings(ctx, target.id)).toEqual({
      'inventory.maintenanceBlocksSales': true,
      'calendar.defaultRangeDays': 31,
    })
  })

  it('a valid update is stored and audited as HOTEL_SETTINGS_CHANGED (diff-only)', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], hotelIds: [target.id] })

    const updated = await updateSettings(ctx, target.id, { 'inventory.maintenanceBlocksSales': false })
    expect(updated['inventory.maintenanceBlocksSales']).toBe(false)
    expect(updated['calendar.defaultRangeDays']).toBe(31)

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'HOTEL_SETTINGS_CHANGED'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]!.beforeData).toEqual({ 'inventory.maintenanceBlocksSales': true })
    expect(auditRows[0]!.afterData).toEqual({ 'inventory.maintenanceBlocksSales': false })
  })

  it('an identical second update is a no-op: no new audit row', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], hotelIds: [target.id] })

    await updateSettings(ctx, target.id, { 'inventory.maintenanceBlocksSales': false })
    await updateSettings(ctx, target.id, { 'inventory.maintenanceBlocksSales': false })

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'HOTEL_SETTINGS_CHANGED'))
    expect(auditRows).toHaveLength(1)
  })
})

describe('createHotel — atomicity', () => {
  it('rolls back the hotel insert when the audit write fails', async () => {
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValue(new Error('simulated audit failure'))

    const { scope, organization } = await makeOrg(db)
    const ctx = makeCtx(scope, { permissions: ['hotel.manage'], allHotels: true })

    await expect(createHotel(ctx, VALID_CREATE)).rejects.toThrow('simulated audit failure')

    const rows = await db.select().from(hotel).where(eq(hotel.organizationId, organization.id))
    expect(rows).toEqual([])
  })
})

describe('createHotel — concurrency', () => {
  it('two simultaneous creates with the same org+code -> exactly one succeeds, one is rejected as a conflict, and exactly one hotel row lands', async () => {
    const { scope, organization } = await makeOrg(db)
    const ctxA = makeCtx(scope, { permissions: ['hotel.manage'], allHotels: true })
    const ctxB = makeCtx(scope, { permissions: ['hotel.manage'], allHotels: true })

    const results = await Promise.allSettled([
      createHotel(ctxA, { ...VALID_CREATE, code: 'RACE' }),
      createHotel(ctxB, { ...VALID_CREATE, code: 'RACE' }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'ALREADY_EXISTS', httpStatus: 409 })

    const rows = await db.select().from(hotel).where(eq(hotel.organizationId, organization.id))
    expect(rows).toHaveLength(1)
  })
})

describe('listHotelAudit', () => {
  it('audit.view for hotel A cannot read hotel B\'s log (404)', async () => {
    const { scope } = await makeOrg(db)
    const hotelA = await makeHotel(db, scope)
    const hotelB = await makeHotel(db, scope)
    await tenantRepos(db, scope).audit.record({ hotelId: hotelA.id, entityType: 'hotel', entityId: hotelA.id, action: 'HOTEL_CREATED' })
    await tenantRepos(db, scope).audit.record({ hotelId: hotelB.id, entityType: 'hotel', entityId: hotelB.id, action: 'HOTEL_CREATED' })

    const ctx = makeCtx(scope, { permissions: ['audit.view'], hotelIds: [hotelA.id] })

    await expect(listHotelAudit(ctx, hotelB.id, { limit: 50 })).rejects.toBeInstanceOf(NotFoundError)
    const page = await listHotelAudit(ctx, hotelA.id, { limit: 50 })
    expect(page.items).toHaveLength(1)
  })

  it('org-level audit rows (hotel_id null) never appear in a hotel log', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    await tenantRepos(db, scope).audit.record({ hotelId: null, entityType: 'organization', entityId: scope.organizationId, action: 'DEMO_RESET' })
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'hotel', entityId: target.id, action: 'HOTEL_CREATED' })

    const ctx = makeCtx(scope, { permissions: ['audit.view'], hotelIds: [target.id] })
    const page = await listHotelAudit(ctx, target.id, { limit: 50 })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.action).toBe('HOTEL_CREATED')
  })

  it('filters by entityType and by action', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'hotel', entityId: target.id, action: 'HOTEL_CREATED' })
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'hotel', entityId: target.id, action: 'HOTEL_UPDATED' })
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'floor', entityId: 'some-floor', action: 'FLOOR_CREATED' })

    const ctx = makeCtx(scope, { permissions: ['audit.view'], hotelIds: [target.id] })

    const byEntityType = await listHotelAudit(ctx, target.id, { entityType: 'floor', limit: 50 })
    expect(byEntityType.items.map(i => i.action)).toEqual(['FLOOR_CREATED'])

    const byAction = await listHotelAudit(ctx, target.id, { action: 'HOTEL_UPDATED', limit: 50 })
    expect(byAction.items.map(i => i.action)).toEqual(['HOTEL_UPDATED'])
  })

  it('cursor pages are stable: no row repeated or skipped when a new row is written between page requests (proves BOTH no-repeat AND no-skip)', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const base = new Date('2027-01-01T00:00:00.000Z')

    // Three known, trackable rows with strictly increasing created_at — a deterministic
    // created_at DESC, id DESC ordering: originalC first, then originalB, then originalA.
    const originalA = await insertAuditRow(scope, { hotelId: target.id, createdAt: new Date(base.getTime() + 0) })
    const originalB = await insertAuditRow(scope, { hotelId: target.id, createdAt: new Date(base.getTime() + 1000) })
    const originalC = await insertAuditRow(scope, { hotelId: target.id, createdAt: new Date(base.getTime() + 2000) })

    const ctx = makeCtx(scope, { permissions: ['audit.view'], hotelIds: [target.id] })

    const page1 = await listHotelAudit(ctx, target.id, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items.map(i => i.id)).toEqual([originalC.id, originalB.id])
    expect(page1.nextCursor).not.toBeNull()

    // A newer row (created_at AFTER all three originals) lands between the page-1 and page-2
    // requests. With this repository's keyset scheme — (created_at, id) < (cursor.createdAt,
    // cursor.id), cursor taken from page 1's last row (originalB) — page 2 can only ever see rows
    // strictly OLDER than originalB, so this newer row must never retroactively appear on page 2.
    const newerRow = await insertAuditRow(scope, { hotelId: target.id, createdAt: new Date(base.getTime() + 3000) })

    const page2 = await listHotelAudit(ctx, target.id, { cursor: auditCursorSchema.parse(page1.nextCursor!), limit: 50 })

    const page1Ids = page1.items.map(i => i.id)
    const page2Ids = page2.items.map(i => i.id)
    const combined = [...page1Ids, ...page2Ids]

    // No duplicate ids across page 1 + page 2.
    expect(new Set(combined).size).toBe(combined.length)

    // The actual "no skip" proof: all three originals appear across the two pages, each exactly once.
    for (const original of [originalA, originalB, originalC]) {
      expect(combined.filter(id => id === original.id)).toHaveLength(1)
    }

    // The newly inserted newer row never surfaces on the older page 2.
    expect(page2Ids).not.toContain(newerRow.id)

    // Page 2 is the final page (only originalA remains, older than the cursor) -> nextCursor null.
    expect(page2.items.map(i => i.id)).toEqual([originalA.id])
    expect(page2.nextCursor).toBeNull()
  })

  it('filters by entityType AND entityId together: only the exact target row(s) come back', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const TARGET_ENTITY_ID = 'room-target'

    // Same entityType ('room'), different entityId.
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'room', entityId: 'room-other', action: 'HOTEL_UPDATED' })
    // The exact target: entityType 'room' + entityId === TARGET_ENTITY_ID.
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'room', entityId: TARGET_ENTITY_ID, action: 'HOTEL_UPDATED', reason: 'target-row' })
    // A completely different entityType, same entityId string.
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'floor', entityId: TARGET_ENTITY_ID, action: 'FLOOR_CREATED' })

    const ctx = makeCtx(scope, { permissions: ['audit.view'], hotelIds: [target.id] })
    const page = await listHotelAudit(ctx, target.id, { entityType: 'room', entityId: TARGET_ENTITY_ID, limit: 50 })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.entityType).toBe('room')
    expect(page.items[0]!.entityId).toBe(TARGET_ENTITY_ID)
    expect(page.items[0]!.reason).toBe('target-row')
  })

  it('rows sharing the exact same created_at are ordered by id DESC, and paginating across the tie boundary produces no repeat/skip', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const tiedTimestamp = new Date('2027-06-15T12:00:00.000Z')

    // Insert several rows sharing the exact same created_at, capture their DB-generated ids.
    const tied = await Promise.all(
      Array.from({ length: 4 }, () => insertAuditRow(scope, { hotelId: target.id, createdAt: tiedTimestamp })),
    )
    const expectedOrder = [...tied].map(r => r.id).sort().reverse() // id DESC

    const ctx = makeCtx(scope, { permissions: ['audit.view'], hotelIds: [target.id] })

    // Unfiltered call spanning all tied rows: confirms the id DESC tie-break.
    const all = await listHotelAudit(ctx, target.id, { limit: 50 })
    expect(all.items.map(i => i.id)).toEqual(expectedOrder)

    // Paginate across the tie boundary with a small limit that lands mid-group.
    const page1 = await listHotelAudit(ctx, target.id, { limit: 2 })
    expect(page1.items.map(i => i.id)).toEqual(expectedOrder.slice(0, 2))
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await listHotelAudit(ctx, target.id, { cursor: auditCursorSchema.parse(page1.nextCursor!), limit: 2 })
    expect(page2.items.map(i => i.id)).toEqual(expectedOrder.slice(2, 4))
    // This repository's convention (AuditRepository#listForHotel): a page that exactly fills
    // `limit` always gets a non-null nextCursor, even when no further rows actually exist — the
    // caller only learns the true end from the NEXT fetch coming back with fewer rows than `limit`.
    // Page 2 here has exactly 2 items === limit, so it still carries a cursor.
    expect(page2.nextCursor).not.toBeNull()

    // No repeated or skipped id across the full paginated sequence.
    const combined = [...page1.items.map(i => i.id), ...page2.items.map(i => i.id)]
    expect(combined).toEqual(expectedOrder)
    expect(new Set(combined).size).toBe(expectedOrder.length)

    // The following fetch (past the true end) confirms termination: 0 rows, nextCursor null.
    const page3 = await listHotelAudit(ctx, target.id, { cursor: auditCursorSchema.parse(page2.nextCursor!), limit: 2 })
    expect(page3.items).toEqual([])
    expect(page3.nextCursor).toBeNull()
  })

  it('actor.fullName resolves for a same-organization user, and is null for a deleted user', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    const actor = await makeUser(db, scope, { fullName: 'Audit Actor' })
    await tenantRepos(db, scope).audit.record({ hotelId: target.id, entityType: 'hotel', entityId: target.id, action: 'HOTEL_UPDATED', actorUserId: actor.id })

    const ctx = makeCtx(scope, { permissions: ['audit.view'], hotelIds: [target.id] })
    const before = await listHotelAudit(ctx, target.id, { limit: 50 })
    expect(before.items[0]!.actor).toEqual({ id: actor.id, fullName: 'Audit Actor' })

    await db.delete(appUser).where(eq(appUser.id, actor.id))
    const after = await listHotelAudit(ctx, target.id, { limit: 50 })
    expect(after.items[0]!.actor).toBeNull()
  })

  it('an actor_user_id belonging to another organization (forced/corrupted data) resolves to null, never another org\'s name', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const target = await makeHotel(db, orgA)
    const crossOrgUser = await makeUser(db, orgB, { fullName: 'Should Never Appear' })
    await tenantRepos(db, orgA).audit.record({ hotelId: target.id, entityType: 'hotel', entityId: target.id, action: 'HOTEL_UPDATED', actorUserId: crossOrgUser.id })

    const ctx = makeCtx(orgA, { permissions: ['audit.view'], hotelIds: [target.id] })
    const page = await listHotelAudit(ctx, target.id, { limit: 50 })
    expect(page.items[0]!.actor).toBeNull()
    expect(JSON.stringify(page.items)).not.toContain('Should Never Appear')
  })
})

describe('DTO shape and timezone', () => {
  it('today is computed from the hotel\'s own timezone and the injected clock, not the machine clock', async () => {
    const { scope } = await makeOrg(db)
    const riyadhHotel = await makeHotel(db, scope, { timezone: 'Asia/Riyadh' })
    const utcHotel = await makeHotel(db, scope, { timezone: 'UTC' })
    const clock = () => new Date('2027-05-01T21:30:00Z')
    const ctx = makeCtx(scope, { permissions: ['hotel.view'], allHotels: true, now: clock })

    expect((await getHotel(ctx, riyadhHotel.id)).today).toBe('2027-05-02')
    expect((await getHotel(ctx, utcHotel.id)).today).toBe('2027-05-01')
  })

  it('floorCount is the active-floor count when the caller has room.view, and null otherwise; roomCount (Task 14) follows the same gating', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope)
    await makeFloor(db, trustedHotelScope(scope, target.id), { level: 1, isActive: true })
    await makeFloor(db, trustedHotelScope(scope, target.id), { level: 2, isActive: false })
    const withRoomView = makeCtx(scope, { permissions: ['hotel.view', 'room.view'], hotelIds: [target.id] })
    const withoutRoomView = makeCtx(scope, { permissions: ['hotel.view'], hotelIds: [target.id] })

    const a = await getHotel(withRoomView, target.id)
    const b = await getHotel(withoutRoomView, target.id)
    expect(a.floorCount).toBe(1)
    expect(a.roomCount).toBe(0) // no rooms created in this test -> real count, not null
    expect(b.floorCount).toBeNull()
    expect(b.roomCount).toBeNull()
  })

  it('roomCount is the count of rooms in inventory on the hotel\'s own today, for a caller with room.view', async () => {
    const { scope } = await makeOrg(db)
    const target = await makeHotel(db, scope, { timezone: 'UTC' })
    const floorRow = await makeFloor(db, trustedHotelScope(scope, target.id))
    const roomTypeRow = await makeRoomType(db, scope)
    const hotelScope = trustedHotelScope(scope, target.id)
    // In inventory on the clock's date:
    await makeRoomWithVersion(db, hotelScope, floorRow.id, roomTypeRow.id, {}, { validFrom: '2027-01-01', validTo: null })
    // Retired before the clock's date -> excluded:
    await makeRoomWithVersion(db, hotelScope, floorRow.id, roomTypeRow.id, {}, { validFrom: '2026-01-01', validTo: '2026-12-31' })

    const clock = () => new Date('2027-05-01T12:00:00Z')
    const ctx = makeCtx(scope, { permissions: ['hotel.view', 'room.view'], hotelIds: [target.id], now: clock })

    expect((await getHotel(ctx, target.id)).roomCount).toBe(1)
  })
})

describe('listHotels — floorCount is batched (N+1-free)', () => {
  it('counts ACTIVE floors only, and issues exactly ONE call to HotelRepository.activeFloorCounts for the whole list (not one per hotel)', async () => {
    const { scope } = await makeOrg(db)
    const hotelA = await makeHotel(db, scope, { code: 'FA' })
    const hotelB = await makeHotel(db, scope, { code: 'FB' })
    await makeHotel(db, scope, { code: 'FC' }) // no floors at all

    await makeFloor(db, trustedHotelScope(scope, hotelA.id), { level: 1, isActive: true })
    await makeFloor(db, trustedHotelScope(scope, hotelA.id), { level: 2, isActive: true })
    await makeFloor(db, trustedHotelScope(scope, hotelA.id), { level: 3, isActive: false })
    await makeFloor(db, trustedHotelScope(scope, hotelB.id), { level: 1, isActive: true })

    const spy = vi.spyOn(HotelRepository.prototype, 'activeFloorCounts')
    const ctx = makeCtx(scope, { permissions: ['hotel.view', 'room.view'], allHotels: true })

    const result = await listHotels(ctx)

    expect(spy).toHaveBeenCalledTimes(1)

    const byCode = new Map(result.map(h => [h.code, h.floorCount]))
    expect(byCode.get('FA')).toBe(2)
    expect(byCode.get('FB')).toBe(1)
    expect(byCode.get('FC')).toBe(0)
  })

  it('never calls activeFloorCounts or roomCounts at all when the caller lacks room.view', async () => {
    const { scope } = await makeOrg(db)
    await makeHotel(db, scope)

    const floorSpy = vi.spyOn(HotelRepository.prototype, 'activeFloorCounts')
    const roomSpy = vi.spyOn(HotelRepository.prototype, 'roomCounts')
    const ctx = makeCtx(scope, { permissions: ['hotel.view'], allHotels: true })

    const result = await listHotels(ctx)

    expect(floorSpy).not.toHaveBeenCalled()
    expect(roomSpy).not.toHaveBeenCalled()
    expect(result.every(h => h.floorCount === null && h.roomCount === null)).toBe(true)
  })
})

describe('listHotels — roomCount is batched (N+1-free) and respects each hotel\'s own timezone', () => {
  it('issues exactly ONE call to HotelRepository.roomCounts for the whole list (not one per hotel), using each hotel\'s own local today', async () => {
    const { scope } = await makeOrg(db)
    // Two hotels in DIFFERENT timezones so their "today" can differ for the same instant.
    const hotelA = await makeHotel(db, scope, { code: 'RA', timezone: 'Pacific/Kiritimati' }) // UTC+14
    const hotelB = await makeHotel(db, scope, { code: 'RB', timezone: 'Pacific/Niue' }) // UTC-11
    const floorA = await makeFloor(db, trustedHotelScope(scope, hotelA.id))
    const floorB = await makeFloor(db, trustedHotelScope(scope, hotelB.id))
    const roomType = await makeRoomType(db, scope)

    // An instant where Kiritimati's calendar date is already one day ahead of Niue's.
    const clock = () => new Date('2027-05-01T20:00:00Z')

    // In inventory on hotel A's local today (2027-05-02) but NOT on hotel B's (still 2027-05-01
    // there at this instant) -- proves the count uses EACH hotel's own today, not one shared date.
    await makeRoomWithVersion(db, trustedHotelScope(scope, hotelA.id), floorA.id, roomType.id, {}, { validFrom: '2027-05-02', validTo: null })
    await makeRoomWithVersion(db, trustedHotelScope(scope, hotelB.id), floorB.id, roomType.id, {}, { validFrom: '2027-05-02', validTo: null })

    const spy = vi.spyOn(HotelRepository.prototype, 'roomCounts')
    const ctx = makeCtx(scope, { permissions: ['hotel.view', 'room.view'], allHotels: true, now: clock })

    const result = await listHotels(ctx)

    expect(spy).toHaveBeenCalledTimes(1)
    const byCode = new Map(result.map(h => [h.code, h.roomCount]))
    expect(byCode.get('RA')).toBe(1) // hotel A's room started exactly on hotel A's local today
    expect(byCode.get('RB')).toBe(0) // hotel B's room does not start until hotel B's tomorrow
  })
})
