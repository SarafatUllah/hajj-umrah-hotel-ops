import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { appUser, auditLog, documentAsset, hotel, hotelDocument, organization, room } from '../../../db/schema'
import { seedDemoOrganization, DEMO_ORG_SLUG } from '../../../db/seed/demo-org'
import { seedOrganizationRoles, seedPermissionCatalog } from '../../../db/seed/rbac'
import { demoIds } from '../../../db/seed/demo/ids'
import { hotelRepos, tenantRepos } from '../../../server/repositories'
import { OperationalBlockRepository } from '../../../server/repositories/hotel'
import { PlatformOrganizationRepository } from '../../../server/repositories/platform/organizationRepository'
import { PlatformPermissionCatalogRepository } from '../../../server/repositories/platform/permissionCatalogRepository'
import { resolveAuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, trustedOrganizationScope, type OrganizationScope } from '../../../server/security/scope'
import { DemoOrganizationNotFoundError, DemoResetForbiddenError, resetDemoData } from '../../../server/services/demo.service'
import { updateSettings } from '../../../server/services/hotelService'
import { cancelRoomBlock, createRoomBlock } from '../../../server/services/operationalBlockService'
import { changeBaseConfig, createRoom } from '../../../server/services/roomService'
import { authenticate } from '../../../server/services/auth.service'
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from '../../../server/demo/personas'
import { PERMISSIONS } from '../../../shared/constants/permissions'
import { demoContext } from '../../support/demoContext'
import { fingerprintOrganization } from '../../support/fingerprint'
import { makeCapacityPeriod, makeFloor, makeHotel, makeHotelDocument, makeOrg, makeRoomBlock, makeRoomCapacityOverride, makeRoomType, makeRoomWithVersion, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()
const ADMIN_ID = demoIds.user('admin')
const DEMO_ORG_ID = demoIds.organization(DEMO_ORG_SLUG)
const actor = { userId: ADMIN_ID, organizationId: DEMO_ORG_ID }

beforeEach(async () => {
  await truncateAllTables()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await truncateAllTables()
  await closeTestDb()
})

/** A second, fully populated NON-demo organization touching every table the demo reset's cascade could reach. */
async function populateOtherOrg(): Promise<{ organizationId: string, scope: OrganizationScope, auditRows: number }> {
  const { organization: org, scope } = await makeOrg(db, { slug: 'second-org' })
  await seedPermissionCatalog(db)
  const roleIdByKey = await seedOrganizationRoles(db, org.id)
  const h = await makeHotel(db, scope)
  const hotelScope = trustedHotelScope(scope, h.id)
  const user = await makeUser(db, scope, { hotelIds: [h.id] })
  await tenantRepos(db, scope).roles.assignToUser(user.id, roleIdByKey.HOTEL_MANAGER!)
  const type = await makeRoomType(db, scope)
  const f = await makeFloor(db, hotelScope)
  const { room: r1 } = await makeRoomWithVersion(db, hotelScope, f.id, type.id)
  const { room: r2 } = await makeRoomWithVersion(db, hotelScope, f.id, type.id)
  const period = await makeCapacityPeriod(db, hotelScope)
  await makeRoomCapacityOverride(db, hotelScope, r1.id, period.id)
  await makeRoomBlock(db, hotelScope, r2.id)
  await hotelRepos(db, hotelScope).settings.upsert('inventory.maintenanceBlocksSales', true)
  await makeHotelDocument(db, hotelScope)
  await tenantRepos(db, scope).audit.record({ actorUserId: user.id, entityType: 'hotel', entityId: h.id, action: 'HOTEL_CREATED', hotelId: h.id })
  return { organizationId: org.id, scope, auditRows: 1 }
}

async function count_(table: typeof auditLog | typeof room | typeof hotel, organizationId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table).where(eq(table.organizationId, organizationId))
  return Number(row!.n)
}

async function seedBaseline() {
  await seedDemoOrganization(db)
  const baseline = await fingerprintOrganization(db, DEMO_ORG_ID)
  return { baseline }
}

describe('demo reset: restores the exact deterministic baseline', () => {
  it('after real changes (a new room, a base change, a block, a setting, audit rows) the fingerprint equals the fresh baseline, ids unchanged, a DEMO_RESET audit row exists', async () => {
    const { baseline } = await seedBaseline()
    const admin = await demoContext(db, 'admin')

    const quad = demoIds.roomType('QUAD')
    const created = await createRoom(admin, demoIds.hotel('MKK-GRAND'), { floorId: demoIds.floor('MKK-GRAND', 2), roomTypeId: quad, roomNumber: '299', inServiceFrom: '2026-09-02', features: [] })
    await changeBaseConfig(admin, demoIds.hotel('MKK-GRAND'), demoIds.room('MKK-GRAND', '401'), { effectiveFrom: '2026-10-01', physicalBeds: 5, sellableCapacity: 5 })
    const block = await createRoomBlock(admin, demoIds.hotel('MKK-GRAND'), created.id, { kind: 'OPERATIONAL_BLOCK', startDate: '2026-10-05', endDate: '2026-10-07', reason: 'Test block' })
    await cancelRoomBlock(admin, demoIds.hotel('MKK-GRAND'), block.id, { reason: 'Test cancel' })
    await updateSettings(admin, demoIds.hotel('MED-CENT'), { 'inventory.maintenanceBlocksSales': false } as never)

    const changed = await fingerprintOrganization(db, DEMO_ORG_ID)
    expect(changed.hash).not.toBe(baseline.hash)
    expect(await count_(auditLog, DEMO_ORG_ID)).toBeGreaterThan(3) // real audit rows from the legitimate services
    expect(await count_(room, DEMO_ORG_ID)).toBe(361)

    const result = await resetDemoData(actor)

    expect(result.organizationId).toBe(DEMO_ORG_ID)
    const after = await fingerprintOrganization(db, DEMO_ORG_ID)
    expect(after.hash).toBe(baseline.hash)
    expect(after.tables).toEqual(baseline.tables)
    expect(await count_(room, DEMO_ORG_ID)).toBe(360)
    // The old audit rows are gone with the organization; exactly the DEMO_RESET row remains.
    const audit = await db.select().from(auditLog).where(eq(auditLog.organizationId, DEMO_ORG_ID))
    expect(audit.map(a => a.action)).toEqual(['DEMO_RESET'])
    expect(audit[0]!.actorUserId).toBe(ADMIN_ID)
    expect(audit[0]!.entityId).toBe(DEMO_ORG_ID)
  })

  it('a reset keeps the resetter working: same user id, same permissions (incl. organization.resetDemo), the login still works, and a SECOND reset succeeds', async () => {
    await seedBaseline()
    const before = await resolveAuthContext(db, { userId: ADMIN_ID, organizationId: DEMO_ORG_ID })
    expect(before?.authz.permissions.has('organization.resetDemo')).toBe(true)

    await resetDemoData(actor)
    const afterFirst = await resolveAuthContext(db, { userId: ADMIN_ID, organizationId: DEMO_ORG_ID })
    expect(afterFirst?.identity.userId).toBe(ADMIN_ID)
    expect([...afterFirst!.authz.permissions].sort()).toEqual([...PERMISSIONS].sort())
    expect(afterFirst!.authz.allHotels).toBe(true)
    expect((await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_PASSWORD))?.user.id).toBe(ADMIN_ID)

    const second = await resetDemoData(actor)
    expect(second.organizationId).toBe(DEMO_ORG_ID)
    const [users] = await db.select({ n: count() }).from(appUser).where(eq(appUser.organizationId, DEMO_ORG_ID))
    expect(Number(users!.n)).toBe(9)
    expect((await db.select().from(auditLog).where(eq(auditLog.organizationId, DEMO_ORG_ID))).map(a => a.action)).toEqual(['DEMO_RESET'])
  })

  it('reset with an anchorDate moves the anchor-relative data; resetting again with the default returns to the baseline', async () => {
    const { baseline } = await seedBaseline()
    const moved = await resetDemoData(actor, { anchorDate: '2026-11-15' })
    expect(moved.anchorDate).toBe('2026-11-15')
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).not.toBe(baseline.hash)
    expect((await resetDemoData(actor)).anchorDate).toBe('2026-09-01')
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(baseline.hash)
  })

  it('an invalid anchorDate is rejected without touching anything', async () => {
    const { baseline } = await seedBaseline()
    await expect(resetDemoData(actor, { anchorDate: '2026-02-30' })).rejects.toThrow(/anchor/i)
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(baseline.hash)
    expect(await count_(auditLog, DEMO_ORG_ID)).toBe(0)
  })

  it('demo document metadata rows cascade with the organization (Task 20 seeds no documents and adds no storage cleanup: stored bytes, if any, stay orphaned on disk)', async () => {
    await seedBaseline()
    const demoHotel = trustedHotelScope(await scopeOf(DEMO_ORG_ID), demoIds.hotel('MKK-GRAND'))
    await makeHotelDocument(db, demoHotel)
    expect(await db.select().from(hotelDocument).where(eq(hotelDocument.organizationId, DEMO_ORG_ID))).toHaveLength(1)
    expect(await db.select().from(documentAsset).where(eq(documentAsset.organizationId, DEMO_ORG_ID))).toHaveLength(1)

    await resetDemoData(actor)

    expect(await db.select().from(hotelDocument).where(eq(hotelDocument.organizationId, DEMO_ORG_ID))).toHaveLength(0)
    expect(await db.select().from(documentAsset).where(eq(documentAsset.organizationId, DEMO_ORG_ID))).toHaveLength(0)
  })
})

const scopeOf = async (organizationId: string): Promise<OrganizationScope> => trustedOrganizationScope(organizationId)

describe('demo reset: other organizations are untouched', () => {
  it('a second, fully populated organization has a byte-identical fingerprint (and audit/document rows) before and after reset', async () => {
    const other = await populateOtherOrg()
    await seedBaseline()
    const before = await fingerprintOrganization(db, other.organizationId)
    expect(Object.values(before.tables).every(t => t.rows > 0)).toBe(true) // the whole wide graph is populated

    await resetDemoData(actor)
    await resetDemoData(actor, { anchorDate: '2027-02-01' })

    const after = await fingerprintOrganization(db, other.organizationId)
    expect(after.hash).toBe(before.hash)
    expect(after.tables).toEqual(before.tables)
    expect(await count_(auditLog, other.organizationId)).toBe(other.auditRows)
    expect((await db.select().from(documentAsset).where(eq(documentAsset.organizationId, other.organizationId)))).toHaveLength(1)
    expect((await db.select().from(hotelDocument).where(eq(hotelDocument.organizationId, other.organizationId)))).toHaveLength(1)
    expect(await db.select().from(organization).where(eq(organization.slug, 'second-org'))).toHaveLength(1)
  })

  it('a real organization holding the slug "demo" (not is_demo) is refused and untouched', async () => {
    const { organization: real } = await makeOrg(db, { slug: DEMO_ORG_SLUG, isDemo: false })
    const user = await makeUser(db, await scopeOf(real.id))
    await expect(resetDemoData({ userId: user.id, organizationId: real.id })).rejects.toBeInstanceOf(DemoOrganizationNotFoundError)
    await expect(seedDemoOrganization(db)).rejects.toThrow(/non-demo organization/)
    expect(await db.select().from(organization).where(eq(organization.id, real.id))).toHaveLength(1)
    expect(await db.select().from(appUser).where(eq(appUser.organizationId, real.id))).toHaveLength(1)
  })

  it('another organization\'s members (even a user with the same id space) cannot reset the demo organization', async () => {
    const { baseline } = await seedBaseline()
    const other = await populateOtherOrg()
    const [foreign] = await db.select().from(appUser).where(eq(appUser.organizationId, other.organizationId))
    await expect(resetDemoData({ userId: foreign!.id, organizationId: other.organizationId })).rejects.toBeInstanceOf(DemoResetForbiddenError)
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(baseline.hash)
  })
})

describe('demo reset: atomic and concurrency-safe', () => {
  it('a failure mid-reseed (during the blocks step) rolls everything back: the previous state, including later changes, is intact', async () => {
    await seedBaseline()
    const admin = await demoContext(db, 'admin')
    await createRoom(admin, demoIds.hotel('MKK-GRAND'), { floorId: demoIds.floor('MKK-GRAND', 2), roomTypeId: demoIds.roomType('QUAD'), roomNumber: '299', inServiceFrom: '2026-09-02', features: [] })
    const mutated = await fingerprintOrganization(db, DEMO_ORG_ID)
    const auditBefore = await count_(auditLog, DEMO_ORG_ID)
    const other = await populateOtherOrg()
    const otherBefore = await fingerprintOrganization(db, other.organizationId)

    const spy = vi.spyOn(OperationalBlockRepository.prototype, 'insertMany').mockRejectedValue(new Error('induced mid-reseed failure'))
    await expect(resetDemoData(actor)).rejects.toThrow('induced mid-reseed failure')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()

    // The delete, the recreated hotels/rooms/versions/periods/overrides: all rolled back.
    const after = await fingerprintOrganization(db, DEMO_ORG_ID)
    expect(after.hash).toBe(mutated.hash)
    expect(await count_(room, DEMO_ORG_ID)).toBe(361)
    expect(await count_(auditLog, DEMO_ORG_ID)).toBe(auditBefore) // no DEMO_RESET row either
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'DEMO_RESET')))).toHaveLength(0)
    expect((await fingerprintOrganization(db, other.organizationId)).hash).toBe(otherBefore.hash)
    // and the system still works afterwards
    expect((await resetDemoData(actor)).organizationId).toBe(DEMO_ORG_ID)
  })

  it('a failure at the very last step (the audit insert) also rolls back the whole reseed', async () => {
    const { baseline } = await seedBaseline()
    await expect(resetDemoData({ ...actor, userId: 'not-a-uuid' })).rejects.toThrow()
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(baseline.hash)
    expect(await count_(auditLog, DEMO_ORG_ID)).toBe(0)
  })

  it('two (and three) simultaneous resets are serialized: all succeed, no duplicate rows, no constraint failure, baseline fingerprint, other organization untouched', async () => {
    const other = await populateOtherOrg()
    const { baseline } = await seedBaseline()
    const otherBefore = await fingerprintOrganization(db, other.organizationId)

    const results = await Promise.allSettled([resetDemoData(actor), resetDemoData(actor), resetDemoData(actor)])

    for (const r of results) expect(r.status, JSON.stringify(r)).toBe('fulfilled')
    expect(await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG))).toHaveLength(1)
    expect(await count_(room, DEMO_ORG_ID)).toBe(360)
    expect(await count_(hotel, DEMO_ORG_ID)).toBe(5)
    const after = await fingerprintOrganization(db, DEMO_ORG_ID)
    expect(after.hash).toBe(baseline.hash)
    // one DEMO_RESET row per reset is gone with each recreate; only the last one is left
    expect((await db.select().from(auditLog).where(eq(auditLog.organizationId, DEMO_ORG_ID))).map(a => a.action)).toEqual(['DEMO_RESET'])
    expect((await fingerprintOrganization(db, other.organizationId)).hash).toBe(otherBefore.hash)
  })

  it('even when the organization lookups are artificially delayed so every reset has READ the demo organization before any deletes it (forced interleaving), the advisory lock serializes them', async () => {
    const { baseline } = await seedBaseline()
    // The permission-catalog upsert row-locks the global permission rows, which would serialize concurrent seeds
    // by accident; it is a no-op here (the catalog is already seeded) so ONLY the advisory lock can do the job.
    vi.spyOn(PlatformPermissionCatalogRepository.prototype, 'upsertAll').mockResolvedValue(undefined)
    const original = PlatformOrganizationRepository.prototype.findBySlug
    vi.spyOn(PlatformOrganizationRepository.prototype, 'findBySlug').mockImplementation(async function (this: PlatformOrganizationRepository, slug: string) {
      const found = await original.call(this, slug)
      await new Promise(resolve => setTimeout(resolve, 250))
      return found
    })
    const results = await Promise.allSettled([resetDemoData(actor), resetDemoData(actor), seedDemoOrganization(db)])
    for (const r of results) expect(r.status, JSON.stringify(r)).toBe('fulfilled')
    expect(await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG))).toHaveLength(1)
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(baseline.hash)
  })

  it('a reset concurrent with a reseed of the same organization also settles consistently', async () => {
    const { baseline } = await seedBaseline()
    const results = await Promise.allSettled([resetDemoData(actor), seedDemoOrganization(db)])
    for (const r of results) expect(r.status, JSON.stringify(r)).toBe('fulfilled')
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(baseline.hash)
  })
})

describe('demo reset: duration', () => {
  it('a full reset (cascade delete + reseed + audit) completes well under 15 seconds', async () => {
    await seedBaseline()
    const started = performance.now()
    await resetDemoData(actor)
    const first = performance.now() - started
    const startedAgain = performance.now()
    await resetDemoData(actor)
    const second = performance.now() - startedAgain
    console.info(`[demo reset duration] first=${Math.round(first)}ms second=${Math.round(second)}ms`)
    expect(first).toBeLessThan(15_000)
    expect(second).toBeLessThan(15_000)
  })
})
