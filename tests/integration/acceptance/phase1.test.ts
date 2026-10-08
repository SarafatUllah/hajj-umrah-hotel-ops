import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog } from '../../../db/schema'
import { seedDemoOrganization } from '../../../db/seed/demo-org'
import { seedOrganizationRoles, seedPermissionCatalog } from '../../../db/seed/rbac'
import { demoIds } from '../../../db/seed/demo/ids'
import { DEMO_HOTELS, DEMO_ORG_SLUG } from '../../../server/demo/catalog'
import { tenantRepos } from '../../../server/repositories'
import { type AuthContext, resolveAuthContext } from '../../../server/security/authContext'
import { requireOrgPermission } from '../../../server/security/authorize'
import { trustedHotelScope } from '../../../server/security/scope'
import { authenticate } from '../../../server/services/auth.service'
import { getHotelAverages, getOrganizationAverages } from '../../../server/services/capacityAverageService'
import { getRoomCapacityTimeline } from '../../../server/services/capacityPeriodService'
import { DemoResetForbiddenError, resetDemoData } from '../../../server/services/demo.service'
import { getHotel, listHotelAudit, listHotels } from '../../../server/services/hotelService'
import { cancelRoomBlock, createRoomBlock, listRoomBlocks } from '../../../server/services/operationalBlockService'
import { getRoomCalendar } from '../../../server/services/roomCalendarService'
import { getRoom, listRooms } from '../../../server/services/roomService'
import { closeDb } from '../../../server/utils/db'
import { hashPassword } from '../../../server/utils/password'
import { listHotelAuditQuerySchema } from '../../../shared/schemas/hotel'
import { listRoomsQuerySchema } from '../../../shared/schemas/room'
import { listRoomBlocksQuerySchema } from '../../../shared/schemas/roomBlock'
import { DEMO_NOW, demoContext } from '../../support/demoContext'
import { fingerprintOrganization, type OrganizationFingerprint } from '../../support/fingerprint'
import { makeCapacityPeriod, makeFloor, makeHotel, makeOrg, makeRoomBlock, makeRoomCapacityOverride, makeRoomType, makeRoomWithVersion, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

/**
 * PHASE 1 ACCEPTANCE GATE (plan Task 21; Part C §13). One readable story over the seeded demo,
 * walked through the REAL login (`authenticate` + `resolveAuthContext`) and the real services — the
 * same code the HTTP routes call. Nothing here re-implements a domain rule: expectations are either
 * the documented requirement examples (Room 401, 310/80, 1578/360) or values read back from the
 * services themselves. Direct database reads are used only for fingerprints and audit evidence.
 *
 * The steps run in file order and build on each other (the maintenance block of step 3 is what the
 * audit step reads and what the reset must undo). The file seeds its own demo organization and its
 * own second organization, so it never depends on another test file.
 */

const db = getTestDb()

const DEMO_ORG_ID = demoIds.organization(DEMO_ORG_SLUG)
const GRAND = demoIds.hotel('MKK-GRAND')
const AJYAD = demoIds.hotel('MKK-AJYAD')
const ROOM_401 = demoIds.room('MKK-GRAND', '401')
const ROOM_405 = demoIds.room('MKK-GRAND', '405')

/**
 * The maintenance window for room 405. Chosen from the deterministic plan: room 405 is a Quad with one
 * open-ended base version (in inventory from 2025-01-01) and NO seeded block; the window starts after the
 * demo anchor (blocks must start on or after the hotel's today, 2026-09-01) and touches no seasonal
 * override (Ramadan 2027 starts 2027-02-08). Step 3 re-proves "nothing there yet" through the calendar.
 */
const MAINTENANCE = { from: '2026-10-11', to: '2026-10-13' } as const
const CALENDAR_WINDOW = { from: '2026-10-09', to: '2026-10-15' } as const
const MAINTENANCE_REASON = 'Acceptance: air-conditioning compressor replacement'

const SECOND_ORG_SLUG = 'acceptance-second-org'
const SECOND_ORG_ADMIN_EMAIL = 'super.admin@second-org.test'
const SECOND_ORG_PASSWORD = 'Second-Org-Password-42!'

interface Rejection { httpStatus: number | undefined, code: string | undefined, message: string }

/** Runs a call that MUST reject and returns its HTTP-relevant shape (status, stable code, message). */
async function rejectionOf(call: () => unknown): Promise<Rejection> {
  const error = await Promise.resolve().then(call).then(() => null, (e: unknown) => e)
  expect(error, 'expected the call to be rejected').not.toBeNull()
  const e = error as { httpStatus?: number, code?: string, message?: string }
  return { httpStatus: e.httpStatus, code: e.code, message: String(e.message) }
}

/**
 * The 404 a caller gets from `call` is IDENTICAL (status, code, message) to the 404 the same caller gets
 * for an id that does not exist anywhere — so the response proves nothing about the resource's existence.
 * (Thunks, not promises: each call starts only when it is awaited.)
 */
async function expectIndistinguishable404(call: () => Promise<unknown>, nonexistent: () => Promise<unknown>): Promise<void> {
  const actual = await rejectionOf(call)
  const baseline = await rejectionOf(nonexistent)
  expect(actual.httpStatus).toBe(404)
  expect(actual).toEqual(baseline)
}

/** Room 405's calendar row over CALENDAR_WINDOW, through the real calendar service (room-number search). */
async function room405Calendar(ctx: AuthContext) {
  const calendar = await getRoomCalendar(ctx, GRAND, { ...CALENDAR_WINDOW, q: '405' })
  const row = calendar.rooms.find(r => r.roomId === ROOM_405)
  expect(row, 'room 405 is on the calendar page').toBeDefined()
  return { calendar, row: row! }
}

// Shared story state (filled in by beforeAll and the steps, in order).
let freshDemo: OrganizationFingerprint
let secondOrg: { organizationId: string, hotelId: string, roomId: string, blockId: string, fingerprint: OrganizationFingerprint }
let secondOrgAdmin: AuthContext
let maintenanceBlockId = ''

/** Signs the second organization's Super Admin in through the real login service and resolves its context. */
async function signInSecondOrgAdmin(): Promise<AuthContext> {
  const auth = await authenticate(SECOND_ORG_SLUG, SECOND_ORG_ADMIN_EMAIL, SECOND_ORG_PASSWORD)
  expect(auth, 'second organization Super Admin can log in').not.toBeNull()
  const ctx = await resolveAuthContext(db, { userId: auth!.user.id, organizationId: auth!.user.organizationId }, DEMO_NOW)
  expect(ctx).not.toBeNull()
  return ctx!
}

beforeAll(async () => {
  await truncateAllTables()

  // 1. The demo organization, exactly as `pnpm db:seed` builds it, and its fresh fingerprint.
  const seeded = await seedDemoOrganization(db)
  expect(seeded.organizationId).toBe(DEMO_ORG_ID)
  freshDemo = await fingerprintOrganization(db, DEMO_ORG_ID)

  // 2. A separate, populated, NON-demo organization with its own Super Admin (all hotels, full role catalogue),
  //    built with the shared test fixtures and the real RBAC seed.
  const { organization, scope } = await makeOrg(db, { slug: SECOND_ORG_SLUG, name: 'Second Organization (acceptance)' })
  await seedPermissionCatalog(db)
  const roleIdByKey = await seedOrganizationRoles(db, organization.id)
  const admin = await makeUser(db, scope, { email: SECOND_ORG_ADMIN_EMAIL, fullName: 'Second Org Super Admin', passwordHash: await hashPassword(SECOND_ORG_PASSWORD), allHotels: true })
  await tenantRepos(db, scope).roles.assignToUser(admin.id, roleIdByKey.SUPER_ADMIN!)
  const ownHotel = await makeHotel(db, scope, { code: 'SECOND-HTL' })
  const hotelScope = trustedHotelScope(scope, ownHotel.id)
  const type = await makeRoomType(db, scope)
  const ownFloor = await makeFloor(db, hotelScope, { level: 1 })
  const { room: ownRoom } = await makeRoomWithVersion(db, hotelScope, ownFloor.id, type.id, { roomNumber: '101' })
  const period = await makeCapacityPeriod(db, hotelScope)
  await makeRoomCapacityOverride(db, hotelScope, ownRoom.id, period.id)
  const ownBlock = await makeRoomBlock(db, hotelScope, ownRoom.id)
  secondOrg = { organizationId: organization.id, hotelId: ownHotel.id, roomId: ownRoom.id, blockId: ownBlock.id, fingerprint: await fingerprintOrganization(db, organization.id) }
  secondOrgAdmin = await signInSecondOrgAdmin()
}, 120_000)

afterAll(async () => {
  await truncateAllTables()
  await closeTestDb()
  await closeDb()
})

describe('Phase 1 acceptance: the demo story end to end', () => {
  it('1. reception.grand (Reception) sees exactly MKK-GRAND; MKK-AJYAD answers the same 404 as a hotel that does not exist', async () => {
    const reception = await demoContext(db, 'reception.grand')

    const visible = await listHotels(reception)
    expect(visible.map(h => h.code)).toEqual(['MKK-GRAND'])
    expect((await getHotel(reception, GRAND)).code).toBe('MKK-GRAND')

    // Real authorization (authorizeHotel), not the seeded access rows: the other Makkah hotel is invisible,
    // for the hotel itself and for its inventory, and indistinguishable from a random id.
    await expectIndistinguishable404(() => getHotel(reception, AJYAD), () => getHotel(reception, randomUUID()))
    await expectIndistinguishable404(
      () => getRoomCalendar(reception, AJYAD, CALENDAR_WINDOW),
      () => getRoomCalendar(reception, randomUUID(), CALENDAR_WINDOW),
    )
  })

  it('2. manager.grand: room 401 capacity timeline is 4/4 BASE -> 6/6 Hajj 2027 override (2027-05-01..07-31) -> 4/4 BASE', async () => {
    const manager = await demoContext(db, 'manager.grand')

    const timeline = await getRoomCapacityTimeline(manager, GRAND, ROOM_401, { from: '2027-04-30', to: '2027-08-01' })
    expect(timeline.segments.map(s => [s.from, s.to, s.physicalBeds, s.sellableCapacity, s.source])).toEqual([
      ['2027-04-30', '2027-04-30', 4, 4, 'BASE'],
      ['2027-05-01', '2027-07-31', 6, 6, 'PERIOD_OVERRIDE'],
      ['2027-08-01', '2027-08-01', 4, 4, 'BASE'],
    ])
    const hajjPeriodId = timeline.segments[1]!.periodId!
    expect(timeline.refs.periods[hajjPeriodId]).toMatchObject({ name: 'Hajj 2027', kind: 'HAJJ', startDate: '2027-05-01', endDate: '2027-07-31' })

    // The four boundary nights, one by one.
    for (const [date, beds, source] of [['2027-04-30', 4, 'BASE'], ['2027-05-01', 6, 'PERIOD_OVERRIDE'], ['2027-07-31', 6, 'PERIOD_OVERRIDE'], ['2027-08-01', 4, 'BASE']] as const) {
      const night = await getRoomCapacityTimeline(manager, GRAND, ROOM_401, { from: date, to: date })
      expect(night.segments.map(s => [s.physicalBeds, s.sellableCapacity, s.source]), date).toEqual([[beds, beds, source]])
    }
  })

  it('3. manager.grand blocks room 405 for MAINTENANCE and the derived calendar shows it on exactly those nights', async () => {
    const manager = await demoContext(db, 'manager.grand')

    // Before: room 405 is in inventory and fully AVAILABLE across the window (no seeded block there).
    const before = await room405Calendar(manager)
    expect(before.row.segments.map(s => [s.from, s.to, s.status, s.blockIds])).toEqual([[CALENDAR_WINDOW.from, CALENDAR_WINDOW.to, 'AVAILABLE', []]])

    const block = await createRoomBlock(manager, GRAND, ROOM_405, { kind: 'MAINTENANCE', startDate: MAINTENANCE.from, endDate: MAINTENANCE.to, reason: MAINTENANCE_REASON })
    expect(block).toMatchObject({ room: { id: ROOM_405, roomNumber: '405' }, kind: 'MAINTENANCE', startDate: MAINTENANCE.from, endDate: MAINTENANCE.to, nights: 3, phase: 'UPCOMING', cancelAction: 'CANCEL' })
    maintenanceBlockId = block.id

    // After: the SAME derived calendar now carries a MAINTENANCE run for exactly the block's nights.
    const after = await room405Calendar(manager)
    expect(after.row.segments.map(s => [s.from, s.to, s.status, s.blockIds])).toEqual([
      [CALENDAR_WINDOW.from, '2026-10-10', 'AVAILABLE', []],
      [MAINTENANCE.from, MAINTENANCE.to, 'MAINTENANCE', [block.id]],
      ['2026-10-14', CALENDAR_WINDOW.to, 'AVAILABLE', []],
    ])
    // Capacity is untouched by a block (blocks change availability only); sellability follows the hotel setting.
    const maintenanceRun = after.row.segments[1]!
    expect([maintenanceRun.physicalBeds, maintenanceRun.sellableCapacity, maintenanceRun.capacitySource]).toEqual([4, 4, 'BASE'])
    expect(maintenanceRun.sellable).toBe(!after.calendar.meta.maintenanceBlocksSales)
    expect(after.calendar.refs.blocks[block.id]).toEqual({ kind: 'MAINTENANCE', startDate: MAINTENANCE.from, endDate: MAINTENANCE.to, reason: MAINTENANCE_REASON })
  })

  it('4. MKK-GRAND averages (Task 17 service): the date-effective average rises above the base during Hajj 2027 and equals it again on 2027-08-01', async () => {
    const manager = await demoContext(db, 'manager.grand')

    const preSeason = await getHotelAverages(manager, GRAND, { date: '2027-04-30' })
    const hajj = await getHotelAverages(manager, GRAND, { date: '2027-06-15' })
    const postSeason = await getHotelAverages(manager, GRAND, { date: '2027-08-01' })

    // Outside any seasonal period the date-effective average IS the base average.
    expect(preSeason.dateEffective).toEqual(preSeason.base)
    expect(postSeason.dateEffective).toEqual(postSeason.base)

    // During Hajj 2027: same rooms (same denominator), more sellable capacity, a higher average.
    expect(hajj.dateEffective.denominator).toBe(hajj.base.denominator)
    expect(hajj.dateEffective.numerator).toBeGreaterThan(hajj.base.numerator)
    expect(hajj.dateEffective.value!).toBeGreaterThan(hajj.base.value!)
    expect(hajj.dateEffective.value!).toBeGreaterThan(postSeason.dateEffective.value!)

    // The base average ignores seasons: it does not jump at the Hajj boundaries.
    expect(hajj.base).toEqual(preSeason.base)
    expect(hajj.base).toEqual(postSeason.base)
  })

  it('5. admin (Super Admin, all hotels): MKK-AJYAD base average "3.88" (310/80), organization average "4.38" (1578/360), five hotels', async () => {
    const admin = await demoContext(db, 'admin')

    const ajyad = await getHotelAverages(admin, AJYAD, { date: '2025-07-01' })
    expect(ajyad.base).toEqual({ numerator: 310, denominator: 80, value: 3.875, display: '3.88', basis: 'ROOMS' })

    const organization = await getOrganizationAverages(admin, { date: '2025-07-01' })
    expect(organization.base).toMatchObject({ numerator: 1578, denominator: 360, display: '4.38', basis: 'ROOMS' })
    expect(organization.perHotel).toHaveLength(5)

    const hotels = await listHotels(admin)
    expect(hotels).toHaveLength(5)
    expect(hotels.map(h => h.code).sort()).toEqual(DEMO_HOTELS.map(h => h.code).sort())
  })

  it('6. audit: MKK-GRAND\'s audit log holds the BLOCK_CREATED entry for the maintenance block, by manager.grand, with before/after', async () => {
    expect(maintenanceBlockId, 'step 3 created the block').not.toBe('')
    const manager = await demoContext(db, 'manager.grand')

    const page = await listHotelAudit(manager, GRAND, listHotelAuditQuerySchema.parse({ entityType: 'room_block', entityId: maintenanceBlockId }))
    expect(page.items).toHaveLength(1)
    const entry = page.items[0]!
    expect(entry).toMatchObject({
      action: 'BLOCK_CREATED',
      entityType: 'room_block',
      entityId: maintenanceBlockId,
      actor: { id: demoIds.user('manager.grand'), fullName: 'Nora Al-Qahtani' },
      before: null,
      reason: MAINTENANCE_REASON,
    })
    expect(entry.after).toMatchObject({
      id: maintenanceBlockId,
      organizationId: DEMO_ORG_ID,
      hotelId: GRAND,
      roomId: ROOM_405,
      kind: 'MAINTENANCE',
      startDate: MAINTENANCE.from,
      endDate: MAINTENANCE.to,
      reason: MAINTENANCE_REASON,
      createdBy: demoIds.user('manager.grand'),
      cancelledAt: null,
    })

    // Audit evidence at the row level: the entry is attached to MKK-GRAND inside the demo organization.
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityId, maintenanceBlockId), eq(auditLog.action, 'BLOCK_CREATED')))
    expect(rows.map(r => [r.organizationId, r.hotelId, r.actorUserId])).toEqual([[DEMO_ORG_ID, GRAND, demoIds.user('manager.grand')]])
  })

  it('7. a second organization\'s Super Admin can read, list and reset NOTHING of the demo organization (404 matrix + 403 reset)', async () => {
    const foreign = secondOrgAdmin
    const demoBefore = await fingerprintOrganization(db, DEMO_ORG_ID)
    const nowhere = randomUUID()

    // Lists: only its own hotel, never a demo hotel.
    expect((await listHotels(foreign)).map(h => h.id)).toEqual([secondOrg.hotelId])
    expect((await getOrganizationAverages(foreign, { date: '2025-07-01' })).perHotel.map(h => h.hotelId)).toEqual([secondOrg.hotelId])

    // Demo hotels by id: the same 404 as an id that exists nowhere.
    await expectIndistinguishable404(() => getHotel(foreign, GRAND), () => getHotel(foreign, nowhere))
    await expectIndistinguishable404(() => listRooms(foreign, GRAND, listRoomsQuerySchema.parse({})), () => listRooms(foreign, nowhere, listRoomsQuerySchema.parse({})))
    await expectIndistinguishable404(() => getRoomCalendar(foreign, GRAND, CALENDAR_WINDOW), () => getRoomCalendar(foreign, nowhere, CALENDAR_WINDOW))
    await expectIndistinguishable404(() => listRoomBlocks(foreign, GRAND, listRoomBlocksQuerySchema.parse(CALENDAR_WINDOW)), () => listRoomBlocks(foreign, nowhere, listRoomBlocksQuerySchema.parse(CALENDAR_WINDOW)))
    await expectIndistinguishable404(() => getHotelAverages(foreign, AJYAD, { date: '2025-07-01' }), () => getHotelAverages(foreign, nowhere, { date: '2025-07-01' }))
    await expectIndistinguishable404(() => getOrganizationAverages(foreign, { hotelIds: [GRAND] }), () => getOrganizationAverages(foreign, { hotelIds: [nowhere] }))
    await expectIndistinguishable404(() => listHotelAudit(foreign, GRAND, listHotelAuditQuerySchema.parse({})), () => listHotelAudit(foreign, nowhere, listHotelAuditQuerySchema.parse({})))

    // Demo resources by id, smuggled under the foreign admin's OWN hotel: still the plain "not found".
    await expectIndistinguishable404(() => getRoom(foreign, secondOrg.hotelId, ROOM_401), () => getRoom(foreign, secondOrg.hotelId, nowhere))
    await expectIndistinguishable404(
      () => getRoomCapacityTimeline(foreign, secondOrg.hotelId, ROOM_401, { from: '2027-04-30', to: '2027-08-01' }),
      () => getRoomCapacityTimeline(foreign, secondOrg.hotelId, nowhere, { from: '2027-04-30', to: '2027-08-01' }),
    )
    await expectIndistinguishable404(
      () => cancelRoomBlock(foreign, secondOrg.hotelId, maintenanceBlockId, { reason: 'foreign cancel attempt' }),
      () => cancelRoomBlock(foreign, secondOrg.hotelId, nowhere, { reason: 'foreign cancel attempt' }),
    )
    await expectIndistinguishable404(
      () => createRoomBlock(foreign, GRAND, ROOM_405, { kind: 'OUT_OF_SERVICE', startDate: MAINTENANCE.from, endDate: MAINTENANCE.to, reason: 'foreign write attempt' }),
      () => createRoomBlock(foreign, nowhere, ROOM_405, { kind: 'OUT_OF_SERVICE', startDate: MAINTENANCE.from, endDate: MAINTENANCE.to, reason: 'foreign write attempt' }),
    )

    // Demo reset (POST /api/admin/demo/reset): layer 1, the route's permission check -> 403 FORBIDDEN (a non-demo
    // Super Admin never holds organization.resetDemo); layer 2, the service refuses a non-member (the route maps it to 403).
    expect(foreign.authz.permissions.has('organization.resetDemo')).toBe(false)
    expect(await rejectionOf(() => requireOrgPermission(foreign, 'organization.resetDemo'))).toMatchObject({ httpStatus: 403, code: 'FORBIDDEN' })
    await expect(resetDemoData({ userId: foreign.identity.userId, organizationId: foreign.identity.organizationId })).rejects.toBeInstanceOf(DemoResetForbiddenError)

    // Nothing of the demo organization changed (the maintenance block is still there), nothing of its own either.
    expect((await fingerprintOrganization(db, DEMO_ORG_ID)).hash).toBe(demoBefore.hash)
    expect((await fingerprintOrganization(db, secondOrg.organizationId)).hash).toBe(secondOrg.fingerprint.hash)
  })

  it('8. admin resets the demo: the fingerprint equals the fresh seed, the second organization is byte-identical, ids and sessions stay usable', async () => {
    const managerIdentity = { userId: demoIds.user('manager.grand'), organizationId: DEMO_ORG_ID }
    const beforeReset = await fingerprintOrganization(db, DEMO_ORG_ID)
    // The story changed the demo state (step 3's block): the reset has something to undo.
    expect(beforeReset.hash).not.toBe(freshDemo.hash)
    expect(beforeReset.tables.room_operational_block!.rows).toBe(freshDemo.tables.room_operational_block!.rows + 1)

    const admin = await demoContext(db, 'admin')
    requireOrgPermission(admin, 'organization.resetDemo') // the route's first layer passes for the demo Super Admin
    const result = await resetDemoData({ userId: admin.identity.userId, organizationId: admin.identity.organizationId })
    expect(result).toEqual({ organizationId: DEMO_ORG_ID, anchorDate: '2026-09-01' })

    // Exact restoration of the fresh seed; the other tenant untouched.
    const afterReset = await fingerprintOrganization(db, DEMO_ORG_ID)
    expect(afterReset.tables).toEqual(freshDemo.tables)
    expect(afterReset.hash).toBe(freshDemo.hash)
    const secondAfter = await fingerprintOrganization(db, secondOrg.organizationId)
    expect(secondAfter.tables).toEqual(secondOrg.fingerprint.tables)
    expect(secondAfter.hash).toBe(secondOrg.fingerprint.hash)

    // Only the DEMO_RESET row is left in the demo audit log (the block's audit went with the old organization).
    const demoAudit = await db.select().from(auditLog).where(eq(auditLog.organizationId, DEMO_ORG_ID))
    expect(demoAudit.map(a => [a.action, a.actorUserId, a.entityId])).toEqual([['DEMO_RESET', demoIds.user('admin'), DEMO_ORG_ID]])

    // Stable deterministic ids: an existing session identity (manager.grand) still resolves, the same room ids
    // answer, the block is gone and room 405 is AVAILABLE again on the same calendar window.
    const managerAgain = await resolveAuthContext(db, managerIdentity, DEMO_NOW)
    expect(managerAgain?.identity.userId).toBe(managerIdentity.userId)
    const calendar = await room405Calendar(managerAgain!)
    expect(calendar.row.segments.map(s => [s.from, s.to, s.status])).toEqual([[CALENDAR_WINDOW.from, CALENDAR_WINDOW.to, 'AVAILABLE']])
    expect((await getRoom(managerAgain!, GRAND, ROOM_401)).id).toBe(ROOM_401)

    // The admin can act again after the reset (fresh login, same ids, same answers).
    const adminAgain = await demoContext(db, 'admin')
    expect(adminAgain.identity).toMatchObject({ userId: admin.identity.userId, organizationId: DEMO_ORG_ID })
    expect((await listHotels(adminAgain)).map(h => h.id).sort()).toEqual(DEMO_HOTELS.map(h => demoIds.hotel(h.code)).sort())
    expect((await getHotelAverages(adminAgain, AJYAD, { date: '2025-07-01' })).base.display).toBe('3.88')

    // And the second organization's admin still works in its own tenant.
    const foreignAgain = await signInSecondOrgAdmin()
    expect((await getRoom(foreignAgain, secondOrg.hotelId, secondOrg.roomId)).id).toBe(secondOrg.roomId)
  })
})
