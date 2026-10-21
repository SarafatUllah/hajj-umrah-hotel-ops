import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { agency, agencyQuota, agencyUser, allocationRule, appUser, auditLog, booking, bookingGuestDetail, bookingPriceLine, passportScan, bookingSetting, hotelTask, piiAccessLog, pilgrim, customer, documentSequence, extraBedPolicy, otpChallenge, priceQuote, rate, capacityPeriod, documentAsset, floor, hotel, hotelDocument, hotelSetting, room, roomBaseConfig, roomCapacityOverride, roomOperationalBlock, roomType, role, rolePermission, userHotelAccess, userRole } from '@hajj/db/schema'
import type { DbOrTx } from '@hajj/db/client'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { AuditRepository, DocumentAssetRepository, HotelRepository, RoleNotInScopeError, RoleRepository, RoomTypeRepository, TenantOrganizationRepository, UserHotelAccessRepository, UserRepository } from '../../../server/repositories/tenant'
import { CapacityPeriodRepository, FloorRepository, HotelDocumentRepository, HotelSettingRepository, InventoryReadRepository, OperationalBlockRepository, RoomBaseConfigRepository, RoomCapacityOverrideRepository, RoomRepository } from '../../../server/repositories/hotel'
import { AgencyRepository, AgencyUserRepository, CustomerRepository, OtpChallengeRepository } from '../../../server/repositories/accounts'
import { AgencyQuotaRepository, AllocationRuleRepository, BookingInventoryRepository, BookingRecordRepository, BookingRepository, BookingSettingRepository, DocumentSequenceRepository, ExtraBedPolicyRepository, GuestRepository, HotelTaskRepository, PassportScanRepository, PiiAccessLogRepository, PilgrimRepository, PriceQuoteRepository, RateRepository } from '../../../server/repositories/booking'
import { makeAgency, makeBooking, makeBookingRoom, makeCustomer, makeGuest, makeHotelWithRooms, makeStay } from '../../support/bookingFixtures'
import { ensurePermissions, makeCapacityPeriod, makeFloor, makeHotel, makeHotelDocument, makeRole, makeRoom, makeRoomBlock, makeRoomCapacityOverride, makeRoomType, makeRoomWithVersion, makeUser, makeUserWithPermissions } from '../../support/fixtures'

/**
 * Behavioral tenant-isolation registry: one entry per `ClassName.method` of every scoped repository.
 * `tenantIsolation.test.ts` runs each case twice on fresh data:
 *   - as org B with org A's ids: the call must be isolated (`expect`), and `unchanged` (if given) must hold;
 *   - as org A with its own ids (positive control): the call must NOT look isolated, which proves the
 *     arrange step really created something to leak and the call itself works.
 * The coverage test fails if a repository exported from a barrel below has a method without an entry.
 */
export type IsolationExpectation = 'empty' | 'null' | 'zero-affected' | 'rejects'

export interface IsolationCase<Ids> {
  /** Label for multi-case entries. */
  name?: string
  /** Creates org A's data and returns the ids an attacker in org B would try. */
  arrange: (db: DbOrTx, orgA: OrganizationScope) => Promise<Ids>
  /** Calls the method under `scope`. For inserts, returns what landed in org A (so a smuggled organization shows up as a row). */
  act: (db: DbOrTx, scope: OrganizationScope, ids: Ids) => Promise<unknown>
  expect: IsolationExpectation
  /** For 'rejects': the rejection must be for this reason (not an unrelated error). */
  rejection?: (error: unknown) => boolean
  /** Runs after the org B call: org A's data must be exactly as arranged. */
  unchanged?: (db: DbOrTx, ids: Ids) => Promise<void>
}

type AnyCase = IsolationCase<unknown>
const isolationCase = <Ids>(c: IsolationCase<Ids>): AnyCase => c as unknown as AnyCase

export { REPOSITORY_BARRELS } from '../../support/repositoryBarrels'

function pgCode(error: unknown): string | undefined {
  for (let e = error as { code?: unknown, cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.code === 'string') return e.code
  }
  return undefined
}
const foreignKeyViolation = (error: unknown) => pgCode(error) === '23503'

/** Phase 2a: org A's confirmed agency booking holding one seat in a room on 2027-06-01..06-03. */
async function arrangeBookedRoom(db: DbOrTx, orgA: OrganizationScope) {
  const { hotel, rooms } = await makeHotelWithRooms(db, orgA, 1)
  const agencyRow = await makeAgency(db, orgA)
  const b = await makeBooking(db, orgA, hotel.id, { agencyId: agencyRow.id, checkIn: '2027-06-01', checkOut: '2027-06-03' })
  const claim = await makeBookingRoom(db, orgA, b, rooms[0]!.id)
  const guest = await makeGuest(db, orgA, b.id, 1)
  await makeStay(db, orgA, b.id, guest.id, claim.id, b.checkIn, b.checkOut)
  return { hotelId: hotel.id, roomId: rooms[0]!.id, agencyId: agencyRow.id }
}

/** Phase 2b: org A's agency HELD booking on one room whose hold already lapsed (the sweep's target). */
async function arrangeLapsedHold(db: DbOrTx, orgA: OrganizationScope) {
  const { hotel, rooms } = await makeHotelWithRooms(db, orgA, 1)
  const agencyRow = await makeAgency(db, orgA)
  const b = await makeBooking(db, orgA, hotel.id, { agencyId: agencyRow.id, status: 'HELD', holdExpiresAt: new Date(Date.now() - 1000) })
  await makeBookingRoom(db, orgA, b, rooms[0]!.id)
  return { hotelId: hotel.id, roomId: rooms[0]!.id, bookingId: b.id }
}

/** Phase 2b: org A's agency booking HELD (hold far in the future) on one room, with a slot and a price line. */
async function arrangeHeldBooking(db: DbOrTx, orgA: OrganizationScope) {
  const { hotel, rooms } = await makeHotelWithRooms(db, orgA, 1)
  const agencyRow = await makeAgency(db, orgA)
  const b = await makeBooking(db, orgA, hotel.id, { agencyId: agencyRow.id, status: 'HELD' })
  const claim = await makeBookingRoom(db, orgA, b, rooms[0]!.id)
  const guest = await makeGuest(db, orgA, b.id, 1)
  await makeStay(db, orgA, b.id, guest.id, claim.id, b.checkIn, b.checkOut)
  await db.insert(bookingPriceLine).values({ organizationId: orgA.organizationId, bookingId: b.id, night: b.checkIn, kind: 'PERSON', quantity: 1, unitAmountHalalas: 100, amountHalalas: 100, vatIncluded: true })
  return { bookingId: b.id }
}

/** Phase 2d: org A's booking slot with the booker's copy of its details, and a staff master for the same passport. */
async function arrangeGuestDetail(db: DbOrTx, orgA: OrganizationScope) {
  const { hotel, rooms } = await makeHotelWithRooms(db, orgA, 1)
  const agencyRow = await makeAgency(db, orgA)
  const b = await makeBooking(db, orgA, hotel.id, { agencyId: agencyRow.id, status: 'HELD' })
  const claim = await makeBookingRoom(db, orgA, b, rooms[0]!.id)
  const guest = await makeGuest(db, orgA, b.id, 1)
  await makeStay(db, orgA, b.id, guest.id, claim.id, b.checkIn, b.checkOut)
  const lookup = 'a'.repeat(64)
  const [detail] = await db.insert(bookingGuestDetail).values({ organizationId: orgA.organizationId, bookingId: b.id, bookingGuestId: guest.id, fullName: 'Pilgrim A', passportNoEncrypted: 'x', passportLookup: lookup, enteredByKind: 'agency' }).returning()
  const [master] = await db.insert(pilgrim).values({ organizationId: orgA.organizationId, fullName: 'Pilgrim A', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNoEncrypted: 'x', passportLookup: lookup, passportExpiry: '2030-01-01' }).returning()
  return { bookingId: b.id, guestId: guest.id, detailId: detail!.id, pilgrimId: master!.id, lookup }
}

/** Phase 2d (check-in, tasks, reminders): org A's confirmed booking with a slot still waiting for details, and an open task. */
async function arrangeConfirmedBooking(db: DbOrTx, orgA: OrganizationScope) {
  const { hotel, rooms } = await makeHotelWithRooms(db, orgA, 1)
  const agencyRow = await makeAgency(db, orgA)
  const b = await makeBooking(db, orgA, hotel.id, { agencyId: agencyRow.id, status: 'CONFIRMED' })
  const claim = await makeBookingRoom(db, orgA, b, rooms[0]!.id)
  const guest = await makeGuest(db, orgA, b.id, 1)
  await makeStay(db, orgA, b.id, guest.id, claim.id, b.checkIn, b.checkOut)
  const [task] = await db.insert(hotelTask).values({ organizationId: orgA.organizationId, hotelId: hotel.id, roomId: rooms[0]!.id, bookingId: b.id, kind: 'EXTRA_BED_SETUP', dueDate: b.checkIn }).returning()
  return { bookingId: b.id, receiptToken: b.receiptToken!, hotelId: hotel.id, roomId: rooms[0]!.id, taskId: task!.id }
}

/** Phase 2d: org A's booking slot with a passport scan in the given status, placed in the slot. */
async function arrangeScan(db: DbOrTx, orgA: OrganizationScope, status = 'NEEDS_REVIEW') {
  const ids = await arrangeGuestDetail(db, orgA)
  const [asset] = await db.insert(documentAsset).values({ organizationId: orgA.organizationId, storageKey: `${orgA.organizationId}/2027/${ids.guestId}.png`, originalFilename: 'p.png', mimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64) }).returning()
  const [scan] = await db.insert(passportScan).values({ organizationId: orgA.organizationId, bookingId: ids.bookingId, bookingGuestId: ids.guestId, documentId: asset!.id, status, uploadedByKind: 'agency' }).returning()
  return { ...ids, scanId: scan!.id, documentId: asset!.id }
}

/** Phase 2b: org A's customer with one open REQUESTED booking. */
async function arrangeCustomerRequest(db: DbOrTx, orgA: OrganizationScope) {
  const { hotel, rooms } = await makeHotelWithRooms(db, orgA, 1)
  const customerRow = await makeCustomer(db, orgA)
  const b = await makeBooking(db, orgA, hotel.id, { bookerType: 'INDIVIDUAL', customerId: customerRow.id, bookingType: 'FAMILY', maleCount: 0, totalCount: 2, status: 'REQUESTED' })
  await makeBookingRoom(db, orgA, b, rooms[0]!.id, { occupancy: 'FAMILY' })
  return { customerId: customerRow.id }
}

/** Phase 2b: a minimal HELD hold of org A's agency on org A's room (one pilgrim). */
async function arrangeHoldInput(db: DbOrTx, orgA: OrganizationScope) {
  const { hotel, rooms } = await makeHotelWithRooms(db, orgA, 1)
  const agencyRow = await makeAgency(db, orgA)
  return { hotelId: hotel.id, roomId: rooms[0]!.id, agencyId: agencyRow.id }
}

/** Phase 2a: org A's approved agency with one active user. */
async function arrangeAgencyUser(db: DbOrTx, orgA: OrganizationScope) {
  const agencyRow = await makeAgency(db, orgA)
  const user = await new AgencyUserRepository(db, orgA).insert({ agencyId: agencyRow.id, email: `agent-${agencyRow.id}@example.test`, passwordHash: 'h', fullName: 'Agent' })
  return { agencyId: agencyRow.id, userId: user.id, email: user.email }
}

/** Phase 2a: org A's customer and an open sign-in challenge. */
async function arrangeCustomerChallenge(db: DbOrTx, orgA: OrganizationScope) {
  const customerRow = await makeCustomer(db, orgA)
  const challenge = await new OtpChallengeRepository(db, orgA).insert({ phone: customerRow.phone, codeHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 300_000) })
  return { customerId: customerRow.id, phone: customerRow.phone, challengeId: challenge.id }
}

/**
 * Phase 2a booking rules: one hotel-scoped rule row of org A per table, created through the same repository class.
 * `values` builds the row from org A's fixtures.
 */
type RuleRepoClass = new (db: DbOrTx, scope: ReturnType<typeof trustedHotelScope>) => { list: () => Promise<unknown[]>, findById: (id: string) => Promise<unknown>, insert: (v: never) => Promise<{ id: string }>, update: (id: string, v: never) => Promise<unknown>, delete: (id: string) => Promise<boolean> }

type RuleIds = { roomTypeId: string, agencyId: string }

/** `values(ids, false)` = the arranged row; `values(ids, true)` = a second row that does not collide with it (insert case). */
function ruleCases(name: string, Repo: RuleRepoClass, table: typeof rate | typeof agencyQuota | typeof allocationRule | typeof extraBedPolicy, values: (ids: RuleIds, second: boolean) => Record<string, unknown>, patch: Record<string, unknown>): Record<string, AnyCase> {
  const arrange = async (db: DbOrTx, orgA: OrganizationScope) => {
    const hotelRow = await makeHotel(db, orgA)
    const [roomTypeRow, secondRoomType] = [await makeRoomType(db, orgA), await makeRoomType(db, orgA)]
    const agencyRow = await makeAgency(db, orgA)
    const scopeA = trustedHotelScope(orgA, hotelRow.id)
    const row = await new Repo(db, scopeA).insert(values({ roomTypeId: roomTypeRow.id, agencyId: agencyRow.id }, false) as never)
    return { hotelId: hotelRow.id, ruleId: row.id, roomTypeId: roomTypeRow.id, secondRoomTypeId: secondRoomType.id, agencyId: agencyRow.id }
  }
  return {
    [`${name}.list`]: isolationCase({ arrange, act: (db, scope, ids) => new Repo(db, trustedHotelScope(scope, ids.hotelId)).list(), expect: 'empty' }),
    [`${name}.findById`]: isolationCase({ arrange, act: (db, scope, ids) => new Repo(db, trustedHotelScope(scope, ids.hotelId)).findById(ids.ruleId), expect: 'null' }),
    [`${name}.insert`]: isolationCase({
      arrange,
      act: async (db, scope, ids) => {
        await new Repo(db, trustedHotelScope(scope, ids.hotelId)).insert({ ...values({ roomTypeId: ids.secondRoomTypeId, agencyId: ids.agencyId }, true), organizationId: (await db.select().from(table).where(eq(table.id, ids.ruleId)))[0]!.organizationId } as never).catch(() => null)
        return (await db.select().from(table).where(eq(table.hotelId, ids.hotelId))).filter(r => r.id !== ids.ruleId)
      },
      expect: 'empty',
    }),
    [`${name}.update`]: isolationCase({ arrange, act: (db, scope, ids) => new Repo(db, trustedHotelScope(scope, ids.hotelId)).update(ids.ruleId, patch as never), expect: 'null' }),
    [`${name}.delete`]: isolationCase({ arrange, act: async (db, scope, ids) => (await new Repo(db, trustedHotelScope(scope, ids.hotelId)).delete(ids.ruleId)) ? 1 : 0, expect: 'zero-affected' }),
  }
}

/** Phase 2a: org A's quote (REQUESTED, or OFFERED and already past validity when `expired`). */
async function arrangeQuote(db: DbOrTx, orgA: OrganizationScope, expired = false) {
  const hotelRow = await makeHotel(db, orgA)
  const agencyRow = await makeAgency(db, orgA)
  const offer = expired ? { status: 'OFFERED', amountHalalas: 1, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date(Date.now() - 1000), offeredAt: new Date() } : {}
  const quote = await new PriceQuoteRepository(db, orgA).insert({ refNo: `Q-T-${agencyRow.id.slice(0, 8)}`, agencyId: agencyRow.id, hotelId: hotelRow.id, bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-05', totalCount: 3, ...offer })
  return { quoteId: quote.id, hotelId: hotelRow.id, agencyId: agencyRow.id }
}

async function assertNoRows(rows: unknown[], what: string) {
  if (rows.length !== 0) throw new Error(`${what}: expected no rows, found ${rows.length}`)
}

/** Task 16: org A's hotel + in-service room (+ optionally one ACTIVE 2027-05-01..05-10 MAINTENANCE block). */
async function arrangeBlockRoom(db: DbOrTx, orgA: OrganizationScope, withBlock: boolean) {
  const hotelRow = await makeHotel(db, orgA)
  const scopeA = trustedHotelScope(orgA, hotelRow.id)
  const floorRow = await makeFloor(db, scopeA)
  const roomTypeRow = await makeRoomType(db, orgA)
  const { room: roomRow } = await makeRoomWithVersion(db, scopeA, floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
  const block = withBlock ? await makeRoomBlock(db, scopeA, roomRow.id, { startDate: '2027-05-01', endDate: '2027-05-10' }) : null
  return { hotelId: hotelRow.id, roomId: roomRow.id, blockId: block?.id ?? '' }
}

/** Task 16: org A's block must still be active and unshortened (no cancellation/early-end leaked across the scope). */
async function assertBlockUntouched(db: DbOrTx, blockId: string) {
  const [row] = await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.id, blockId))
  if (!row) throw new Error('room_operational_block of org A: expected the row to still exist')
  if (row.cancelledAt !== null || row.endedEarlyAt !== null || row.endDate !== '2027-05-10') throw new Error('room_operational_block of org A: expected the row to be unchanged')
}

/** Task 17: org A's in-service room with a 2027 Hajj override and an active 2027 block (every table `loadRoomInputs` reads). */
async function arrangeInventoryRoom(db: DbOrTx, orgA: OrganizationScope) {
  const { hotelId, roomId } = await arrangeBlockRoom(db, orgA, true)
  const scopeA = trustedHotelScope(orgA, hotelId)
  const period = await makeCapacityPeriod(db, scopeA)
  await makeRoomCapacityOverride(db, scopeA, roomId, period.id)
  return { hotelId, roomId }
}

/** Task 19: org A's hotel with one hotel document (asset + hotel_document), or just an unattached org-A asset when `withDocument` is false. */
async function arrangeDocument(db: DbOrTx, orgA: OrganizationScope, withDocument: boolean) {
  const hotelRow = await makeHotel(db, orgA)
  const scopeA = trustedHotelScope(orgA, hotelRow.id)
  if (withDocument) {
    const { asset } = await makeHotelDocument(db, scopeA)
    return { hotelId: hotelRow.id, assetId: asset.id, orgAId: orgA.organizationId }
  }
  const asset = await new DocumentAssetRepository(db, orgA).insert({ storageKey: `${orgA.organizationId}/2026/unattached.pdf`, originalFilename: 'u.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'c'.repeat(64) })
  return { hotelId: hotelRow.id, assetId: asset.id, orgAId: orgA.organizationId }
}

/** Task 19: org A's asset must still be un-archived. */
async function assertAssetNotArchived(db: DbOrTx, assetId: string) {
  const [row] = await db.select().from(documentAsset).where(eq(documentAsset.id, assetId))
  if (!row || row.archivedAt !== null) throw new Error('document_asset of org A: expected the row to exist and not be archived')
}

export const ISOLATION_REGISTRY: Record<string, AnyCase | AnyCase[]> = {
  'UserRepository.findActiveByEmail': isolationCase({
    arrange: async (db, orgA) => ({ email: (await makeUser(db, orgA)).email }),
    act: (db, scope, ids) => new UserRepository(db, scope).findActiveByEmail(ids.email),
    expect: 'null',
  }),
  'UserRepository.findByEmail': isolationCase({
    arrange: async (db, orgA) => ({ email: (await makeUser(db, orgA, { isActive: false })).email }),
    act: (db, scope, ids) => new UserRepository(db, scope).findByEmail(ids.email),
    expect: 'null',
  }),
  'UserRepository.findById': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id }),
    act: (db, scope, ids) => new UserRepository(db, scope).findById(ids.userId),
    expect: 'null',
  }),
  'UserRepository.findByIdForUpdate': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id }),
    act: (db, scope, ids) => new UserRepository(db, scope).findByIdForUpdate(ids.userId),
    expect: 'null',
  }),
  'UserRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new UserRepository(db, scope).insert({ organizationId: ids.orgAId, email: 'planted@example.test', passwordHash: 'x', fullName: 'Planted' } as never)
      return db.select().from(appUser).where(and(eq(appUser.organizationId, ids.orgAId), eq(appUser.email, 'planted@example.test')))
    },
    expect: 'empty',
  }),

  'RoleRepository.findByKey': isolationCase({
    arrange: async (db, orgA) => ({ key: (await makeRole(db, orgA)).key }),
    act: (db, scope, ids) => new RoleRepository(db, scope).findByKey(ids.key),
    expect: 'null',
  }),
  'RoleRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new RoleRepository(db, scope).insert({ organizationId: ids.orgAId, key: 'PLANTED', name: 'Planted' } as never)
      return db.select().from(role).where(and(eq(role.organizationId, ids.orgAId), eq(role.key, 'PLANTED')))
    },
    expect: 'empty',
  }),
  // role_permission has no organization_id (PF-15): the method must refuse a role outside the scope.
  'RoleRepository.grantPermissions': isolationCase({
    arrange: async (db, orgA) => {
      await ensurePermissions(db, ['probe.grant'])
      return { roleId: (await makeRole(db, orgA)).id }
    },
    act: (db, scope, ids) => new RoleRepository(db, scope).grantPermissions(ids.roleId, ['probe.grant']),
    expect: 'rejects',
    rejection: error => error instanceof RoleNotInScopeError,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(rolePermission).where(eq(rolePermission.roleId, ids.roleId)), 'role_permission of org A\'s role'),
  }),
  'RoleRepository.assignToUser': [
    isolationCase({
      name: 'org A user to org A role',
      arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id, roleId: (await makeRole(db, orgA)).id }),
      act: (db, scope, ids) => new RoleRepository(db, scope).assignToUser(ids.userId, ids.roleId),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => assertNoRows(await db.select().from(userRole).where(eq(userRole.userId, ids.userId)), 'user_role of org A\'s user'),
    }),
    isolationCase({
      name: 'caller\'s own user to org A role',
      arrange: async (db, orgA) => ({ roleId: (await makeRole(db, orgA)).id }),
      act: async (db, scope, ids) => new RoleRepository(db, scope).assignToUser((await makeUser(db, scope)).id, ids.roleId),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => assertNoRows(await db.select().from(userRole).where(eq(userRole.roleId, ids.roleId)), 'user_role of org A\'s role'),
    }),
  ],
  // Joins role_permission (no organization_id, PF-15) only through org-scoped user_role and role predicates.
  'RoleRepository.permissionKeysForUser': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUserWithPermissions(db, orgA, ['probe.read'])).user.id }),
    act: (db, scope, ids) => new RoleRepository(db, scope).permissionKeysForUser(ids.userId),
    expect: 'empty',
  }),
  'RoleRepository.requiresTwoFactorForUser': isolationCase({
    arrange: async (db, orgA) => {
      const { user, role: created } = await makeUserWithPermissions(db, orgA, ['hotel.view'])
      await new RoleRepository(db, orgA).setRequiresTwoFactor(created.id, true)
      return { userId: user.id }
    },
    act: async (db, scope, ids) => ((await new RoleRepository(db, scope).requiresTwoFactorForUser(ids.userId)) ? [true] : []),
    expect: 'empty',
  }),

  'RoleRepository.setRequiresTwoFactor': isolationCase({
    arrange: async (db, orgA) => ({ roleId: (await makeRole(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new RoleRepository(db, scope).setRequiresTwoFactor(ids.roleId, true)
      return db.select().from(role).where(and(eq(role.id, ids.roleId), eq(role.requiresTwoFactor, true)))
    },
    expect: 'empty',
  }),

  'RoleRepository.rolesForUser': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUserWithPermissions(db, orgA, ['probe.read'])).user.id }),
    act: (db, scope, ids) => new RoleRepository(db, scope).rolesForUser(ids.userId),
    expect: 'empty',
  }),

  'AuditRepository.record': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new AuditRepository(db, scope).record({ organizationId: ids.orgAId, entityType: 'probe', entityId: 'probe', action: 'PROBE' } as never)
      return db.select().from(auditLog).where(eq(auditLog.organizationId, ids.orgAId))
    },
    expect: 'empty',
  }),
  'AuditRepository.listForHotel': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      await new AuditRepository(db, orgA).record({ hotelId: hotelRow.id, entityType: 'probe', entityId: 'probe', action: 'PROBE' })
      return { hotelId: hotelRow.id }
    },
    act: async (db, scope, ids) => (await new AuditRepository(db, scope).listForHotel(ids.hotelId, { limit: 10 })).rows,
    expect: 'empty',
  }),
  'AuditRepository.listOrganizationLevel': isolationCase({
    arrange: async (db, orgA) => {
      await new AuditRepository(db, orgA).record({ entityType: 'probe', entityId: 'probe', action: 'PROBE' })
      return {}
    },
    act: async (db, scope) => (await new AuditRepository(db, scope).listOrganizationLevel({ limit: 10 })).rows,
    expect: 'empty',
  }),

  'HotelRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new HotelRepository(db, scope).insert({ organizationId: ids.orgAId, code: 'PLANTED', name: 'Planted', city: 'Makkah' } as never)
      return db.select().from(hotel).where(and(eq(hotel.organizationId, ids.orgAId), eq(hotel.code, 'PLANTED')))
    },
    expect: 'empty',
  }),
  'HotelRepository.findById': isolationCase({
    arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
    act: (db, scope, ids) => new HotelRepository(db, scope).findById(ids.hotelId),
    expect: 'null',
  }),
  'HotelRepository.findByCode': isolationCase({
    arrange: async (db, orgA) => ({ code: (await makeHotel(db, orgA)).code }),
    act: (db, scope, ids) => new HotelRepository(db, scope).findByCode(ids.code),
    expect: 'null',
  }),
  'HotelRepository.listByIds': isolationCase({
    arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
    act: (db, scope, ids) => new HotelRepository(db, scope).listByIds([ids.hotelId]),
    expect: 'empty',
  }),
  'HotelRepository.listAll': isolationCase({
    arrange: async (db, orgA) => { await makeHotel(db, orgA); return {} },
    act: (db, scope) => new HotelRepository(db, scope).listAll(),
    expect: 'empty',
  }),
  'HotelRepository.update': isolationCase({
    arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new HotelRepository(db, scope).update(ids.hotelId, { name: 'Hacked' })
      return db.select().from(hotel).where(and(eq(hotel.id, ids.hotelId), eq(hotel.name, 'Hacked')))
    },
    expect: 'empty',
  }),
  'HotelRepository.setStatus': isolationCase({
    arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new HotelRepository(db, scope).setStatus(ids.hotelId, 'INACTIVE')
      return db.select().from(hotel).where(and(eq(hotel.id, ids.hotelId), eq(hotel.status, 'INACTIVE')))
    },
    expect: 'empty',
  }),

  'UserHotelAccessRepository.hotelIdsForUser': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const user = await makeUser(db, orgA, { hotelIds: [hotelRow.id] })
      return { userId: user.id }
    },
    act: (db, scope, ids) => new UserHotelAccessRepository(db, scope).hotelIdsForUser(ids.userId),
    expect: 'empty',
  }),
  'UserHotelAccessRepository.userIdsForHotel': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      await makeUser(db, orgA, { hotelIds: [hotelRow.id] })
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new UserHotelAccessRepository(db, scope).userIdsForHotel(ids.hotelId),
    expect: 'empty',
  }),
  // user_hotel_access rows require BOTH the user and the hotel to belong to the acting scope's
  // organization (two independent composite FKs) — mirrors RoleRepository.assignToUser's two cases.
  'UserHotelAccessRepository.replaceForUser': [
    isolationCase({
      name: 'org A\'s user granted org A\'s hotel',
      arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id, hotelId: (await makeHotel(db, orgA)).id }),
      act: (db, scope, ids) => new UserHotelAccessRepository(db, scope).replaceForUser(ids.userId, [ids.hotelId], null),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => assertNoRows(await db.select().from(userHotelAccess).where(eq(userHotelAccess.userId, ids.userId)), 'user_hotel_access of org A\'s user'),
    }),
    isolationCase({
      name: 'caller\'s own user granted org A\'s hotel',
      arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
      act: async (db, scope, ids) => new UserHotelAccessRepository(db, scope).replaceForUser((await makeUser(db, scope)).id, [ids.hotelId], null),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => assertNoRows(await db.select().from(userHotelAccess).where(eq(userHotelAccess.hotelId, ids.hotelId)), 'user_hotel_access of org A\'s hotel'),
    }),
  ],

  // Hotel-scoped repository: the harness only mints an OrganizationScope for "org B", so the attack
  // simulated is org B's caller holding org A's leaked hotelId — trustedHotelScope(scope, ids.hotelId)
  // builds exactly that (mismatched organizationId/hotelId) scope, same as a real cross-tenant guess.
  'HotelSettingRepository.getAll': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      await new HotelSettingRepository(db, trustedHotelScope(orgA, hotelRow.id)).upsert('checkInGrace', { minutes: 15 })
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new HotelSettingRepository(db, trustedHotelScope(scope, ids.hotelId)).getAll(),
    expect: 'empty',
  }),
  'HotelSettingRepository.upsert': [
    // A mismatched (org B, org A's hotel) scope fails the composite FK on INSERT itself (23503),
    // rather than silently landing a row org A's query would never see.
    isolationCase({
      name: 'fresh key: insert path',
      arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
      act: (db, scope, ids) => new HotelSettingRepository(db, trustedHotelScope(scope, ids.hotelId)).upsert('planted', { x: 1 }),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => assertNoRows(await db.select().from(hotelSetting).where(and(eq(hotelSetting.hotelId, ids.hotelId), eq(hotelSetting.key, 'planted'))), 'hotel_setting of org A\'s hotel'),
    }),
    // An EXISTING key: the conflict target is (organization_id, hotel_id, key), so a mismatched
    // (org B, org A's hotel) scope can never match org A's row on conflict — it falls through to
    // the same INSERT path above and hits the same composite-FK rejection (23503), never a silent
    // UPDATE of org A's row.
    isolationCase({
      name: 'existing key: conflict path never matches another organization\'s row',
      arrange: async (db, orgA) => {
        const hotelRow = await makeHotel(db, orgA)
        await new HotelSettingRepository(db, trustedHotelScope(orgA, hotelRow.id)).upsert('checkInGrace', { minutes: 15 })
        return { hotelId: hotelRow.id }
      },
      act: (db, scope, ids) => new HotelSettingRepository(db, trustedHotelScope(scope, ids.hotelId)).upsert('checkInGrace', { minutes: 999 }),
      expect: 'rejects',
      rejection: foreignKeyViolation,
      unchanged: async (db, ids) => {
        const [row] = await db.select().from(hotelSetting).where(and(eq(hotelSetting.hotelId, ids.hotelId), eq(hotelSetting.key, 'checkInGrace')))
        if (row?.value == null || (row.value as { minutes?: number }).minutes !== 15) {
          throw new Error(`hotel_setting of org A's hotel: expected value unchanged at {minutes: 15}, found ${JSON.stringify(row?.value)}`)
        }
      },
    }),
  ],

  'UserRepository.setAllHotels': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new UserRepository(db, scope).setAllHotels(ids.userId, true)
      return db.select().from(appUser).where(and(eq(appUser.id, ids.userId), eq(appUser.allHotels, true)))
    },
    expect: 'empty',
  }),

  'UserRepository.setPendingTotpSecret': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new UserRepository(db, scope).setPendingTotpSecret(ids.userId, 'pii1.planted')
      return db.select().from(appUser).where(and(eq(appUser.id, ids.userId), eq(appUser.totpPendingSecret, 'pii1.planted')))
    },
    expect: 'empty',
  }),

  'UserRepository.enableTotp': isolationCase({
    arrange: async (db, orgA) => ({ userId: (await makeUser(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new UserRepository(db, scope).enableTotp(ids.userId, 'pii1.planted', new Date(), 1)
      return db.select().from(appUser).where(and(eq(appUser.id, ids.userId), isNotNull(appUser.totpEnabledAt)))
    },
    expect: 'empty',
  }),

  'UserRepository.disableTotp': isolationCase({
    arrange: async (db, orgA) => {
      const user = await makeUser(db, orgA)
      await new UserRepository(db, orgA).enableTotp(user.id, 'pii1.enabled', new Date(), 1)
      return { userId: user.id }
    },
    act: async (db, scope, ids) => {
      await new UserRepository(db, scope).disableTotp(ids.userId)
      return db.select().from(appUser).where(and(eq(appUser.id, ids.userId), isNull(appUser.totpEnabledAt)))
    },
    expect: 'empty',
  }),

  'UserRepository.advanceTotpStep': isolationCase({
    arrange: async (db, orgA) => {
      const user = await makeUser(db, orgA)
      await new UserRepository(db, orgA).enableTotp(user.id, 'pii1.enabled', new Date(), 1)
      return { userId: user.id }
    },
    act: async (db, scope, ids) => {
      await new UserRepository(db, scope).advanceTotpStep(ids.userId, 5)
      return db.select().from(appUser).where(and(eq(appUser.id, ids.userId), eq(appUser.totpLastStep, 5)))
    },
    expect: 'empty',
  }),

  // getOwn() takes no id parameter — it can only ever return the CALLING scope's own organization
  // row, so a leak would show up as: called with org B's scope, it returns org A's row anyway.
  // Encoded with the existing 'empty' semantics: the returned id is wrapped in an array only when it
  // equals org A's id, which happens in the positive control (scope IS org A) and must never happen
  // in the isolation case (scope is org B).
  'TenantOrganizationRepository.getOwn': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      const own = await new TenantOrganizationRepository(db, scope).getOwn()
      return own.id === ids.orgAId ? [own.id] : []
    },
    expect: 'empty',
  }),

  // Task 13: PF-13's batched floor-count method — org-scoped, org B's scope must never see org A's
  // hotel's counts even when org B's caller holds the leaked hotelId. Map -> array (via entries()) so
  // the shared 'empty' expectation (array-length based) applies the same way it does everywhere else.
  'HotelRepository.activeFloorCounts': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      await makeFloor(db, trustedHotelScope(orgA, hotelRow.id), { isActive: true })
      return { hotelId: hotelRow.id }
    },
    act: async (db, scope, ids) => [...(await new HotelRepository(db, scope).activeFloorCounts([ids.hotelId])).entries()],
    expect: 'empty',
  }),

  // Hotel-scoped repository (same construction as HotelSettingRepository's cases above): the attack
  // simulated is org B's caller holding org A's leaked hotelId.
  'FloorRepository.insert': isolationCase({
    arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).insert({ level: 1, label: 'Floor 1' })
      return db.select().from(floor).where(eq(floor.hotelId, ids.hotelId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(floor).where(eq(floor.hotelId, ids.hotelId)), 'floor of org A\'s hotel'),
  }),
  'FloorRepository.insertMany': isolationCase({
    arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).insertMany([{ level: 1, label: 'Floor 1' }, { level: 2, label: 'Floor 2' }])
      return db.select().from(floor).where(eq(floor.hotelId, ids.hotelId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(floor).where(eq(floor.hotelId, ids.hotelId)), 'floor of org A\'s hotel'),
  }),
  'FloorRepository.findById': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id, floorId: floorRow.id }
    },
    act: (db, scope, ids) => new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).findById(ids.floorId),
    expect: 'null',
  }),
  // Task 15 selector validation (fix round): one batched existence check for `floorIds`.
  'FloorRepository.findByIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id, floorId: floorRow.id }
    },
    act: (db, scope, ids) => new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).findByIds([ids.floorId]),
    expect: 'empty',
  }),
  'FloorRepository.findByLevel': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id), { level: 3 })
      return { hotelId: hotelRow.id, level: floorRow.level }
    },
    act: (db, scope, ids) => new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).findByLevel(ids.level),
    expect: 'null',
  }),
  'FloorRepository.list': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).list({ includeInactive: true }),
    expect: 'empty',
  }),
  'FloorRepository.update': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id, floorId: floorRow.id }
    },
    act: async (db, scope, ids) => {
      await new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).update(ids.floorId, { label: 'Hacked' })
      return db.select().from(floor).where(and(eq(floor.id, ids.floorId), eq(floor.label, 'Hacked')))
    },
    expect: 'empty',
  }),
  'FloorRepository.setActive': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id), { isActive: true })
      return { hotelId: hotelRow.id, floorId: floorRow.id }
    },
    act: async (db, scope, ids) => {
      await new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).setActive(ids.floorId, false)
      return db.select().from(floor).where(and(eq(floor.id, ids.floorId), eq(floor.isActive, false)))
    },
    expect: 'empty',
  }),
  'FloorRepository.countByHotel': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new FloorRepository(db, trustedHotelScope(scope, ids.hotelId)).countByHotel(true),
    expect: 'zero-affected',
  }),

  // Organization-scoped repository (same construction as HotelRepository's cases above).
  'RoomTypeRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new RoomTypeRepository(db, scope).insert({ organizationId: ids.orgAId, code: 'PLANTED', name: 'Planted', defaultPhysicalBeds: 4, defaultSellableCapacity: 4 } as never)
      return db.select().from(roomType).where(and(eq(roomType.organizationId, ids.orgAId), eq(roomType.code, 'PLANTED')))
    },
    expect: 'empty',
  }),
  'RoomTypeRepository.findById': isolationCase({
    arrange: async (db, orgA) => ({ roomTypeId: (await makeRoomType(db, orgA)).id }),
    act: (db, scope, ids) => new RoomTypeRepository(db, scope).findById(ids.roomTypeId),
    expect: 'null',
  }),
  // Task 15 selector validation (fix round): one batched existence check for `roomTypeIds`.
  'RoomTypeRepository.findByIds': isolationCase({
    arrange: async (db, orgA) => ({ roomTypeId: (await makeRoomType(db, orgA)).id }),
    act: (db, scope, ids) => new RoomTypeRepository(db, scope).findByIds([ids.roomTypeId]),
    expect: 'empty',
  }),
  'RoomTypeRepository.findByCode': isolationCase({
    arrange: async (db, orgA) => ({ code: (await makeRoomType(db, orgA)).code }),
    act: (db, scope, ids) => new RoomTypeRepository(db, scope).findByCode(ids.code),
    expect: 'null',
  }),
  'RoomTypeRepository.list': isolationCase({
    arrange: async (db, orgA) => { await makeRoomType(db, orgA); return {} },
    act: (db, scope) => new RoomTypeRepository(db, scope).list({ includeInactive: true }),
    expect: 'empty',
  }),
  'RoomTypeRepository.update': isolationCase({
    arrange: async (db, orgA) => ({ roomTypeId: (await makeRoomType(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new RoomTypeRepository(db, scope).update(ids.roomTypeId, { name: 'Hacked' })
      return db.select().from(roomType).where(and(eq(roomType.id, ids.roomTypeId), eq(roomType.name, 'Hacked')))
    },
    expect: 'empty',
  }),
  'RoomTypeRepository.setActive': isolationCase({
    arrange: async (db, orgA) => ({ roomTypeId: (await makeRoomType(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new RoomTypeRepository(db, scope).setActive(ids.roomTypeId, false)
      return db.select().from(roomType).where(and(eq(roomType.id, ids.roomTypeId), eq(roomType.isActive, false)))
    },
    expect: 'empty',
  }),
  // Task 14: org-wide, one grouped query across every hotel of the organization — org B's scope must
  // never see org A's usage even when it holds the leaked hotel/room-type ids.
  'RoomTypeRepository.usageCounts': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      return { hotelId: hotelRow.id, roomTypeId: roomTypeRow.id }
    },
    act: async (db, scope, ids) => [...(await new RoomTypeRepository(db, scope).usageCounts([{ hotelId: ids.hotelId, asOf: '2025-06-01' }])).entries()],
    expect: 'empty',
  }),

  // Task 14: PF-13-style batched room-count method — org-scoped, spans every hotel of the org.
  'HotelRepository.roomCounts': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      return { hotelId: hotelRow.id }
    },
    act: async (db, scope, ids) => [...(await new HotelRepository(db, scope).roomCounts([{ hotelId: ids.hotelId, asOf: '2025-06-01' }])).entries()],
    expect: 'empty',
  }),

  // Hotel-scoped repository (same construction as FloorRepository's cases above): the attack
  // simulated is org B's caller holding org A's leaked hotelId/floorId/roomTypeId.
  'RoomRepository.insert': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      return { hotelId: hotelRow.id, floorId: floorRow.id, roomTypeId: roomTypeRow.id }
    },
    act: async (db, scope, ids) => {
      await new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).insert({ floorId: ids.floorId, roomTypeId: ids.roomTypeId, roomNumber: 'PLANTED-1', features: [], notes: null })
      return db.select().from(room).where(eq(room.hotelId, ids.hotelId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(room).where(eq(room.hotelId, ids.hotelId)), 'room of org A\'s hotel'),
  }),
  'RoomRepository.insertMany': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      return { hotelId: hotelRow.id, floorId: floorRow.id, roomTypeId: roomTypeRow.id }
    },
    act: async (db, scope, ids) => {
      await new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).insertMany([
        { floorId: ids.floorId, roomTypeId: ids.roomTypeId, roomNumber: 'PLANTED-1', features: [], notes: null },
        { floorId: ids.floorId, roomTypeId: ids.roomTypeId, roomNumber: 'PLANTED-2', features: [], notes: null },
      ])
      return db.select().from(room).where(eq(room.hotelId, ids.hotelId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(room).where(eq(room.hotelId, ids.hotelId)), 'room of org A\'s hotel'),
  }),
  'RoomRepository.findById': [
    isolationCase({
      name: 'plain read',
      arrange: async (db, orgA) => {
        const hotelRow = await makeHotel(db, orgA)
        const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
        const roomTypeRow = await makeRoomType(db, orgA)
        const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
        return { hotelId: hotelRow.id, roomId: roomRow.id }
      },
      act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).findById(ids.roomId),
      expect: 'null',
    }),
    // Task 16 fix round: the locked read (retire / block create) is the same scoped lookup — a foreign room is not returned.
    isolationCase({
      name: 'locked read (forUpdate)',
      arrange: async (db, orgA) => {
        const hotelRow = await makeHotel(db, orgA)
        const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
        const roomTypeRow = await makeRoomType(db, orgA)
        const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
        return { hotelId: hotelRow.id, roomId: roomRow.id }
      },
      act: (db, scope, ids) => db.transaction(tx => new RoomRepository(tx, trustedHotelScope(scope, ids.hotelId)).findById(ids.roomId, { forUpdate: true })),
      expect: 'null',
    }),
  ],
  'RoomRepository.findByNumber': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, { roomNumber: '777' })
      return { hotelId: hotelRow.id, roomNumber: roomRow.roomNumber }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).findByNumber(ids.roomNumber),
    expect: 'null',
  }),
  'RoomRepository.findByNumbers': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, { roomNumber: '778' })
      return { hotelId: hotelRow.id, roomNumber: roomRow.roomNumber }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).findByNumbers([ids.roomNumber]),
    expect: 'empty',
  }),
  'RoomRepository.listPage': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id }
    },
    act: async (db, scope, ids) => (await new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).listPage({ asOf: '2025-06-01', page: 1, pageSize: 20 })).rows,
    expect: 'empty',
  }),
  'RoomRepository.update': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: async (db, scope, ids) => {
      await new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).update(ids.roomId, { notes: 'Hacked' })
      return db.select().from(room).where(and(eq(room.id, ids.roomId), eq(room.notes, 'Hacked')))
    },
    expect: 'empty',
  }),
  'RoomRepository.listAllOnFloor': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, floorId: floorRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).listAllOnFloor(ids.floorId),
    expect: 'empty',
  }),
  'RoomRepository.countInInventory': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).countInInventory('2025-06-01'),
    expect: 'zero-affected',
  }),
  'RoomRepository.countInInventoryOnFloor': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      return { hotelId: hotelRow.id, floorId: floorRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).countInInventoryOnFloor(ids.floorId, '2025-06-01'),
    expect: 'zero-affected',
  }),
  'RoomRepository.countInInventoryByFloor': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      return { hotelId: hotelRow.id }
    },
    act: async (db, scope, ids) => [...(await new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).countInInventoryByFloor('2025-06-01')).entries()],
    expect: 'empty',
  }),

  'RoomBaseConfigRepository.insert': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: async (db, scope, ids) => {
      await new RoomBaseConfigRepository(db, trustedHotelScope(scope, ids.hotelId)).insert({ roomId: ids.roomId, validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4, origin: 'MANUAL' })
      return db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, ids.roomId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, ids.roomId)), 'room_base_config of org A\'s room'),
  }),
  'RoomBaseConfigRepository.insertMany': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: async (db, scope, ids) => {
      await new RoomBaseConfigRepository(db, trustedHotelScope(scope, ids.hotelId)).insertMany([
        { roomId: ids.roomId, validFrom: '2025-01-01', validTo: null, physicalBeds: 4, sellableCapacity: 4, origin: 'MANUAL' },
      ])
      return db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, ids.roomId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(roomBaseConfig).where(eq(roomBaseConfig.roomId, ids.roomId)), 'room_base_config of org A\'s room'),
  }),
  'RoomBaseConfigRepository.versionsForRoom': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: (db, scope, ids) => new RoomBaseConfigRepository(db, trustedHotelScope(scope, ids.hotelId)).versionsForRoom(ids.roomId),
    expect: 'empty',
  }),
  'RoomBaseConfigRepository.versionsForRooms': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: (db, scope, ids) => new RoomBaseConfigRepository(db, trustedHotelScope(scope, ids.hotelId)).versionsForRooms([ids.roomId]),
    expect: 'empty',
  }),
  'RoomBaseConfigRepository.closeVersion': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { baseVersion } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, versionId: baseVersion.id }
    },
    act: async (db, scope, ids) => {
      await new RoomBaseConfigRepository(db, trustedHotelScope(scope, ids.hotelId)).closeVersion(ids.versionId, '2025-06-01')
      return db.select().from(roomBaseConfig).where(and(eq(roomBaseConfig.id, ids.versionId), eq(roomBaseConfig.validTo, '2025-06-01')))
    },
    expect: 'empty',
  }),

  // Task 15: RoomRepository's override-selector-resolution extensions (same construction as the
  // existing RoomRepository cases above).
  'RoomRepository.idsInInventoryOn': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).idsInInventoryOn('2025-06-01'),
    expect: 'empty',
  }),
  'RoomRepository.findByIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).findByIds([ids.roomId]),
    expect: 'empty',
  }),
  'RoomRepository.listByFloorIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, floorId: floorRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).listByFloorIds([ids.floorId]),
    expect: 'empty',
  }),
  'RoomRepository.listByRoomTypeIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomTypeId: roomTypeRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).listByRoomTypeIds([ids.roomTypeId]),
    expect: 'empty',
  }),
  'RoomRepository.listAll': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new RoomRepository(db, trustedHotelScope(scope, ids.hotelId)).listAll(),
    expect: 'empty',
  }),

  // Task 16 fix round: the multi-room lock (bulk block create, override apply) — a foreign room is neither returned nor locked.
  'RoomRepository.lockByIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const roomRow = await makeRoom(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: (db, scope, ids) => db.transaction(tx => new RoomRepository(tx, trustedHotelScope(scope, ids.hotelId)).lockByIds([ids.roomId])),
    expect: 'empty',
  }),

  // Task 15: CapacityPeriodRepository (Hotel scope, same construction as FloorRepository's cases above).
  'CapacityPeriodRepository.insert': isolationCase({
    arrange: async (db, orgA) => ({ hotelId: (await makeHotel(db, orgA)).id }),
    act: async (db, scope, ids) => {
      await new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).insert({ name: 'Planted', kind: 'HAJJ', startDate: '2027-01-01', endDate: '2027-01-05', notes: null })
      return db.select().from(capacityPeriod).where(eq(capacityPeriod.hotelId, ids.hotelId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(capacityPeriod).where(eq(capacityPeriod.hotelId, ids.hotelId)), 'capacity_period of org A\'s hotel'),
  }),
  'CapacityPeriodRepository.findById': [
    isolationCase({
      name: 'plain read',
      arrange: async (db, orgA) => {
        const hotelRow = await makeHotel(db, orgA)
        const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
        return { hotelId: hotelRow.id, periodId: period.id }
      },
      act: (db, scope, ids) => new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).findById(ids.periodId),
      expect: 'null',
    }),
    // Task 16 fix round (N1): the locked read (period date edit / override apply) is the same scoped lookup — a foreign period is not returned.
    isolationCase({
      name: 'locked read (forUpdate)',
      arrange: async (db, orgA) => {
        const hotelRow = await makeHotel(db, orgA)
        const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
        return { hotelId: hotelRow.id, periodId: period.id }
      },
      act: (db, scope, ids) => db.transaction(tx => new CapacityPeriodRepository(tx, trustedHotelScope(scope, ids.hotelId)).findById(ids.periodId, { forUpdate: true })),
      expect: 'null',
    }),
  ],
  'CapacityPeriodRepository.list': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).list({ includePast: true, today: '2027-01-01' }),
    expect: 'empty',
  }),
  'CapacityPeriodRepository.findByIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id, periodId: period.id }
    },
    act: (db, scope, ids) => new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).findByIds([ids.periodId]),
    expect: 'empty',
  }),
  'CapacityPeriodRepository.update': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id, periodId: period.id }
    },
    act: async (db, scope, ids) => {
      await new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).update(ids.periodId, { name: 'Hacked' })
      return db.select().from(capacityPeriod).where(and(eq(capacityPeriod.id, ids.periodId), eq(capacityPeriod.name, 'Hacked')))
    },
    expect: 'empty',
  }),
  // The first hard-delete method registered in this file: `act` inverts the usual "query for the
  // hacked evidence" idiom into "query for the row's continued EXISTENCE" — isolated (org B) means
  // delete() affected 0 rows so the row survives (act returns [], matching 'empty'); the positive
  // control (org A) actually deletes it (act returns a non-empty marker array).
  'CapacityPeriodRepository.delete': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id, periodId: period.id }
    },
    act: async (db, scope, ids) => {
      await new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).delete(ids.periodId)
      const remaining = await db.select().from(capacityPeriod).where(eq(capacityPeriod.id, ids.periodId))
      return remaining.length === 0 ? [{ deleted: true }] : []
    },
    expect: 'empty',
    unchanged: async (db, ids) => {
      const [row] = await db.select().from(capacityPeriod).where(eq(capacityPeriod.id, ids.periodId))
      if (!row) throw new Error('capacity_period of org A\'s period: expected the row to still exist, but it was deleted')
    },
  }),
  'CapacityPeriodRepository.countOverrides': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, periodId: period.id }
    },
    act: (db, scope, ids) => new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).countOverrides(ids.periodId),
    expect: 'zero-affected',
  }),
  'CapacityPeriodRepository.overrideCountsByPeriod': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id }
    },
    act: async (db, scope, ids) => [...(await new CapacityPeriodRepository(db, trustedHotelScope(scope, ids.hotelId)).overrideCountsByPeriod()).entries()],
    expect: 'empty',
  }),

  // Task 15: RoomCapacityOverrideRepository (Hotel scope).
  'RoomCapacityOverrideRepository.insertMany': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      return { hotelId: hotelRow.id, roomId: roomRow.id, periodId: period.id }
    },
    act: async (db, scope, ids) => {
      await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).insertMany([
        { roomId: ids.roomId, periodId: ids.periodId, validFrom: '2027-05-01', validTo: '2027-07-31', physicalBeds: 6, sellableCapacity: 6, reason: null },
      ])
      return db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, ids.roomId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.roomId, ids.roomId)), 'room_capacity_override of org A\'s room'),
  }),
  'RoomCapacityOverrideRepository.findByPeriod': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, periodId: period.id }
    },
    act: (db, scope, ids) => new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).findByPeriod(ids.periodId),
    expect: 'empty',
  }),
  'RoomCapacityOverrideRepository.listAll': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id }
    },
    act: (db, scope, ids) => new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).listAll(),
    expect: 'empty',
  }),
  'RoomCapacityOverrideRepository.findByRoomIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: (db, scope, ids) => new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).findByRoomIds([ids.roomId], { from: '2027-05-01', to: '2027-07-31' }),
    expect: 'empty',
  }),
  'RoomCapacityOverrideRepository.findAllForRoom': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: (db, scope, ids) => new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).findAllForRoom(ids.roomId),
    expect: 'empty',
  }),
  'RoomCapacityOverrideRepository.findOverlapping': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: (db, scope, ids) => new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).findOverlapping([ids.roomId], { from: '2027-05-01', to: '2027-07-31' }),
    expect: 'empty',
  }),
  'RoomCapacityOverrideRepository.findByIdsInPeriod': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      const override = await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, periodId: period.id, overrideId: override.id }
    },
    act: (db, scope, ids) => new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).findByIdsInPeriod(ids.periodId, [ids.overrideId]),
    expect: 'empty',
  }),
  'RoomCapacityOverrideRepository.deleteById': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      const override = await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, overrideId: override.id }
    },
    act: async (db, scope, ids) => {
      await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).deleteById(ids.overrideId)
      const remaining = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.id, ids.overrideId))
      return remaining.length === 0 ? [{ deleted: true }] : []
    },
    expect: 'empty',
    unchanged: async (db, ids) => {
      const [row] = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.id, ids.overrideId))
      if (!row) throw new Error('room_capacity_override of org A\'s override: expected the row to still exist, but it was deleted')
    },
  }),
  'RoomCapacityOverrideRepository.deleteByIds': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      const override = await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, overrideId: override.id }
    },
    act: async (db, scope, ids) => {
      await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).deleteByIds([ids.overrideId])
      const remaining = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.id, ids.overrideId))
      return remaining.length === 0 ? [{ deleted: true }] : []
    },
    expect: 'empty',
    unchanged: async (db, ids) => {
      const [row] = await db.select().from(roomCapacityOverride).where(eq(roomCapacityOverride.id, ids.overrideId))
      if (!row) throw new Error('room_capacity_override of org A\'s override: expected the row to still exist, but it was deleted')
    },
  }),
  'RoomCapacityOverrideRepository.existsEndingOnOrAfter': isolationCase({
    arrange: async (db, orgA) => {
      const hotelRow = await makeHotel(db, orgA)
      const floorRow = await makeFloor(db, trustedHotelScope(orgA, hotelRow.id))
      const roomTypeRow = await makeRoomType(db, orgA)
      const { room: roomRow } = await makeRoomWithVersion(db, trustedHotelScope(orgA, hotelRow.id), floorRow.id, roomTypeRow.id, {}, { validFrom: '2025-01-01', validTo: null })
      const period = await makeCapacityPeriod(db, trustedHotelScope(orgA, hotelRow.id))
      await makeRoomCapacityOverride(db, trustedHotelScope(orgA, hotelRow.id), roomRow.id, period.id)
      return { hotelId: hotelRow.id, roomId: roomRow.id }
    },
    act: async (db, scope, ids) => (await new RoomCapacityOverrideRepository(db, trustedHotelScope(scope, ids.hotelId)).existsEndingOnOrAfter(ids.roomId, '2027-01-01')) ? 1 : 0,
    expect: 'zero-affected',
  }),

  // Task 16: OperationalBlockRepository (Hotel scope). No delete method exists (blocks are never deleted).
  'OperationalBlockRepository.insert': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, false),
    act: async (db, scope, ids) => {
      await new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).insert({ roomId: ids.roomId, kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-05', reason: 'probe' })
      return db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, ids.roomId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, ids.roomId)), 'room_operational_block of org A\'s room'),
  }),
  'OperationalBlockRepository.insertMany': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, false),
    act: async (db, scope, ids) => {
      await new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).insertMany([{ roomId: ids.roomId, kind: 'MAINTENANCE', startDate: '2027-05-01', endDate: '2027-05-05', reason: 'probe' }])
      return db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, ids.roomId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(roomOperationalBlock).where(eq(roomOperationalBlock.roomId, ids.roomId)), 'room_operational_block of org A\'s room'),
  }),
  'OperationalBlockRepository.findById': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: (db, scope, ids) => new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).findById(ids.blockId),
    expect: 'null',
  }),
  'OperationalBlockRepository.findViewsByIds': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: (db, scope, ids) => new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).findViewsByIds([ids.blockId]),
    expect: 'empty',
  }),
  'OperationalBlockRepository.list': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: async (db, scope, ids) => (await new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).list({ from: '2027-01-01', to: '2027-12-31', includeCancelled: true, page: 1, pageSize: 50 })).rows,
    expect: 'empty',
  }),
  'OperationalBlockRepository.findActiveOverlapping': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: (db, scope, ids) => new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).findActiveOverlapping([ids.roomId], { from: '2027-05-01', to: '2027-05-31' }),
    expect: 'empty',
  }),
  'OperationalBlockRepository.markCancelled': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: (db, scope, ids) => new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).markCancelled(ids.blockId, new Date(), '00000000-0000-0000-0000-0000000000bb', 'probe'),
    expect: 'null',
    unchanged: (db, ids) => assertBlockUntouched(db, ids.blockId),
  }),
  'OperationalBlockRepository.endEarly': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: (db, scope, ids) => new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).endEarly(ids.blockId, { newEndDate: '2027-05-05', at: new Date(), by: '00000000-0000-0000-0000-0000000000bb', reason: 'probe' }),
    expect: 'null',
    unchanged: (db, ids) => assertBlockUntouched(db, ids.blockId),
  }),
  'OperationalBlockRepository.findActiveForRoomsOn': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: (db, scope, ids) => new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).findActiveForRoomsOn([ids.roomId], '2027-05-03'),
    expect: 'empty',
  }),
  'OperationalBlockRepository.findActiveOfKindEndingOnOrAfter': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: (db, scope, ids) => new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).findActiveOfKindEndingOnOrAfter('MAINTENANCE', '2027-01-01'),
    expect: 'empty',
  }),
  'OperationalBlockRepository.existsActiveEndingOnOrAfter': isolationCase({
    arrange: (db, orgA) => arrangeBlockRoom(db, orgA, true),
    act: async (db, scope, ids) => (await new OperationalBlockRepository(db, trustedHotelScope(scope, ids.hotelId)).existsActiveEndingOnOrAfter(ids.roomId, '2027-01-01')) ? 1 : 0,
    expect: 'zero-affected',
  }),

  // Task 17: InventoryReadRepository (Hotel scope, read-only). Org A's room has a base version, a
  // Hajj override and an active block, so a leak through ANY of the four queries would surface as a
  // returned room. Cross-hotel (same organization) cases live in capacityAverageService.test.ts.
  'InventoryReadRepository.loadRoomInputs': [
    isolationCase({
      name: 'whole hotel, blocks included',
      arrange: arrangeInventoryRoom,
      act: (db, scope, ids) => new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).loadRoomInputs({ from: '2027-01-01', to: '2027-12-31' }, { includeBlocks: true }),
      expect: 'empty',
    }),
    isolationCase({
      name: 'org A\'s room ids passed in opts.roomIds',
      arrange: arrangeInventoryRoom,
      act: (db, scope, ids) => new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).loadRoomInputs({ from: '2027-01-01', to: '2027-12-31' }, { roomIds: [ids.roomId], includeBlocks: true }),
      expect: 'empty',
    }),
    isolationCase({
      name: 'several disjoint windows (the OR-of-windows predicates)',
      arrange: arrangeInventoryRoom,
      act: (db, scope, ids) => new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).loadRoomInputs([{ from: '2026-01-01', to: '2026-01-31' }, { from: '2027-01-01', to: '2027-12-31' }], { includeBlocks: true }),
      expect: 'empty',
    }),
    // Task 18: the refs path (override statement joined to capacity_period, block statement with
    // reason) and the pre-loaded-rooms path. The act flattens every loaded row and every ref id, so a
    // leak through ANY statement (or the join) surfaces as a non-empty result.
    isolationCase({
      name: 'Task 18 withRefs: rooms, versions, overrides, blocks and period/block refs',
      arrange: arrangeInventoryRoom,
      act: async (db, scope, ids) => {
        const { rooms, refs } = await new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).loadRoomInputs({ from: '2027-01-01', to: '2027-12-31' }, { includeBlocks: true, includeOutOfInventory: true, withRefs: true })
        return [...rooms, ...refs.periods.keys(), ...refs.blocks.keys()]
      },
      expect: 'empty',
    }),
    isolationCase({
      name: 'Task 18 org A\'s room rows passed in opts.rooms (+ roomIds): no row of org A is read for them',
      arrange: arrangeInventoryRoom,
      act: async (db, scope, ids) => {
        const rooms = [{ id: ids.roomId, roomNumber: 'leaked', floorId: ids.roomId, roomTypeId: ids.roomId }]
        const loaded = await new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).loadRoomInputs({ from: '2027-01-01', to: '2027-12-31' }, { rooms, roomIds: [ids.roomId], includeBlocks: true, includeOutOfInventory: true, withRefs: true })
        return [...loaded.rooms.flatMap(r => [...r.versions, ...r.overrides, ...r.blocks]), ...loaded.refs.periods.keys(), ...loaded.refs.blocks.keys()]
      },
      expect: 'empty',
    }),
  ],
  // Task 18: the calendar's candidate rooms (room joined to floor and room_type, each scoped).
  'InventoryReadRepository.listRoomCandidates': [
    isolationCase({
      name: 'whole hotel',
      arrange: arrangeInventoryRoom,
      act: (db, scope, ids) => new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).listRoomCandidates(),
      expect: 'empty',
    }),
    isolationCase({
      name: 'org A\'s floor and room type ids as filters, and a matching number prefix',
      arrange: async (db, orgA) => {
        const ids = await arrangeInventoryRoom(db, orgA)
        const [row] = await db.select().from(room).where(eq(room.id, ids.roomId))
        return { ...ids, floorId: row!.floorId, roomTypeId: row!.roomTypeId, prefix: row!.roomNumber.slice(0, 2) }
      },
      act: (db, scope, ids) => new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).listRoomCandidates({ floorId: ids.floorId, roomTypeId: ids.roomTypeId, q: ids.prefix }),
      expect: 'empty',
    }),
    // The bounded early-guard form: roomIds (org A's own room id), LIMIT and OFFSET.
    isolationCase({
      name: 'roomIds + limit + offset (the bounded early-guard read): org A\'s room never comes back',
      arrange: arrangeInventoryRoom,
      act: async (db, scope, ids) => {
        const repo = new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId))
        return [
          ...await repo.listRoomCandidates({ roomIds: [ids.roomId], limit: 5001 }),
          ...await repo.listRoomCandidates({ limit: 5000, offset: 0 }),
        ]
      },
      expect: 'empty',
    }),
  ],
  // Task 18: the hotel's in-inventory room ids (ONE single-table statement on room_base_config).
  'InventoryReadRepository.listRoomIdsInInventory': [
    isolationCase({
      name: 'whole hotel, any range, with and without limit',
      arrange: arrangeInventoryRoom,
      act: async (db, scope, ids) => {
        const repo = new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId))
        return [
          ...await repo.listRoomIdsInInventory({ from: '2000-01-01', to: '2100-12-31' }),
          ...await repo.listRoomIdsInInventory({ from: '2027-01-01', to: '2027-01-31' }, { limit: 5001 }),
        ]
      },
      expect: 'empty',
    }),
    isolationCase({
      name: 'org A\'s room id passed as roomIds: no version of it is read',
      arrange: arrangeInventoryRoom,
      act: (db, scope, ids) => new InventoryReadRepository(db, trustedHotelScope(scope, ids.hotelId)).listRoomIdsInInventory({ from: '2000-01-01', to: '2100-12-31' }, { roomIds: [ids.roomId] }),
      expect: 'empty',
    }),
  ],
  // Task 19: DocumentAssetRepository (Organization scope). No delete method exists (documents are archived, never deleted).
  'DocumentAssetRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new DocumentAssetRepository(db, scope).insert({ organizationId: ids.orgAId, storageKey: `${scope.organizationId}/2026/planted.pdf`, originalFilename: 'p.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: 'd'.repeat(64) } as never)
      return db.select().from(documentAsset).where(and(eq(documentAsset.organizationId, ids.orgAId), eq(documentAsset.originalFilename, 'p.pdf')))
    },
    expect: 'empty',
  }),
  'DocumentAssetRepository.findById': isolationCase({
    arrange: (db, orgA) => arrangeDocument(db, orgA, true),
    act: (db, scope, ids) => new DocumentAssetRepository(db, scope).findById(ids.assetId),
    expect: 'null',
  }),
  'DocumentAssetRepository.markArchived': isolationCase({
    arrange: (db, orgA) => arrangeDocument(db, orgA, true),
    act: (db, scope, ids) => new DocumentAssetRepository(db, scope).markArchived(ids.assetId, new Date()),
    expect: 'null',
    unchanged: (db, ids) => assertAssetNotArchived(db, ids.assetId),
  }),

  // Task 19: HotelDocumentRepository (Hotel scope). No delete method exists. Cross-hotel (same
  // organization) cases and the captured SQL live in documentService.test.ts.
  'HotelDocumentRepository.insert': isolationCase({
    arrange: (db, orgA) => arrangeDocument(db, orgA, false),
    act: async (db, scope, ids) => {
      await new HotelDocumentRepository(db, trustedHotelScope(scope, ids.hotelId)).insert({ documentId: ids.assetId, docType: 'LICENSE', title: 'probe', description: null })
      return db.select().from(hotelDocument).where(eq(hotelDocument.documentId, ids.assetId))
    },
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => assertNoRows(await db.select().from(hotelDocument).where(eq(hotelDocument.documentId, ids.assetId)), 'hotel_document of org A\'s asset'),
  }),
  'HotelDocumentRepository.findView': [
    isolationCase({
      name: 'plain',
      arrange: (db, orgA) => arrangeDocument(db, orgA, true),
      act: (db, scope, ids) => new HotelDocumentRepository(db, trustedHotelScope(scope, ids.hotelId)).findView(ids.assetId),
      expect: 'null',
    }),
    isolationCase({
      name: 'forUpdate (inside a transaction)',
      arrange: (db, orgA) => arrangeDocument(db, orgA, true),
      act: (db, scope, ids) => db.transaction(tx => new HotelDocumentRepository(tx, trustedHotelScope(scope, ids.hotelId)).findView(ids.assetId, { forUpdate: true })),
      expect: 'null',
    }),
  ],
  // Phase 2a: BookingInventoryRepository (Hotel scope, read-only) — org B naming org A's hotel and room sees no claim and no seat.
  'BookingInventoryRepository.liveClaims': isolationCase({
    arrange: arrangeBookedRoom,
    act: (db, scope, ids) => new BookingInventoryRepository(db, trustedHotelScope(scope, ids.hotelId)).liveClaims([ids.roomId], '2027-01-01', null),
    expect: 'empty',
  }),
  'BookingInventoryRepository.seatsUsed': isolationCase({
    arrange: arrangeBookedRoom,
    act: (db, scope, ids) => new BookingInventoryRepository(db, trustedHotelScope(scope, ids.hotelId)).seatsUsed([ids.roomId], { from: '2027-01-01', to: '2027-12-31' }),
    expect: 'empty',
  }),
  'BookingInventoryRepository.agencyPersonsByNight': isolationCase({
    arrange: arrangeBookedRoom,
    act: async (db, scope, ids) => [...(await new BookingInventoryRepository(db, trustedHotelScope(scope, ids.hotelId)).agencyPersonsByNight(ids.agencyId, { from: '2027-01-01', to: '2027-12-31' }))],
    expect: 'empty',
  }),
  // The advisory lock key includes the organization and hotel; what it returns is the scoped person count.
  'BookingInventoryRepository.lockAgencyQuota': isolationCase({
    arrange: arrangeBookedRoom,
    act: async (db, scope, ids) => [...(await new BookingInventoryRepository(db, trustedHotelScope(scope, ids.hotelId)).lockAgencyQuota(ids.agencyId, { from: '2027-01-01', to: '2027-12-31' }))],
    expect: 'empty',
  }),
  'BookingInventoryRepository.lockRooms': isolationCase({
    arrange: arrangeBookedRoom,
    act: (db, scope, ids) => new BookingInventoryRepository(db, trustedHotelScope(scope, ids.hotelId)).lockRooms([ids.roomId]),
    expect: 'empty',
  }),
  // Phase 2b holds (Hotel scope): org B can neither write a booking into org A's hotel nor expire org A's holds.
  'BookingRepository.insertHold': isolationCase({
    arrange: arrangeHoldInput,
    act: (db, scope, ids) => new BookingRepository(db, trustedHotelScope(scope, ids.hotelId)).insertHold({
      booking: { bookingNo: `B-T-${ids.roomId.slice(0, 8)}`, bookerType: 'AGENCY', agencyId: ids.agencyId, bookingType: 'GROUP', checkIn: '2027-06-01', checkOut: '2027-06-03', maleCount: 1, totalCount: 1, priceSource: 'PUBLIC', status: 'HELD', holdExpiresAt: new Date(Date.now() + 600_000) },
      rooms: [{ roomId: ids.roomId, occupancy: 'MALE', extraBeds: 0, ownedByAgency: true }],
      guests: [{ slotNo: 1, gender: 'MALE', ageGroup: 'ADULT', isExtraBed: false, roomId: ids.roomId }],
      priceLines: [],
      actor: { kind: 'system', id: null },
    }),
    expect: 'rejects',
    rejection: foreignKeyViolation,
  }),
  'BookingRepository.expireLapsedHolds': isolationCase({
    arrange: arrangeLapsedHold,
    act: (db, scope, ids) => new BookingRepository(db, trustedHotelScope(scope, ids.hotelId)).expireLapsedHolds([ids.roomId], new Date()),
    expect: 'empty',
  }),
  // Phase 2b booking records (Organization scope): org B can neither read, confirm, log on nor expire org A's bookings.
  'BookingRecordRepository.expireLapsed': isolationCase({
    arrange: arrangeLapsedHold,
    act: (db, scope) => new BookingRecordRepository(db, scope).expireLapsed(new Date()),
    expect: 'empty',
  }),
  'BookingRecordRepository.findById': isolationCase({ arrange: arrangeHeldBooking, act: (db, scope, ids) => new BookingRecordRepository(db, scope).findById(ids.bookingId), expect: 'null' }),
  'BookingRecordRepository.list': isolationCase({ arrange: arrangeHeldBooking, act: async (db, scope) => (await new BookingRecordRepository(db, scope).list({ page: 1, pageSize: 50, now: new Date() })).rows, expect: 'empty' }),
  'BookingRecordRepository.details': isolationCase({
    arrange: arrangeHeldBooking,
    act: async (db, scope, ids) => {
      const details = await new BookingRecordRepository(db, scope).details(ids.bookingId)
      return [...details.rooms, ...details.priceLines, ...Object.keys(details.guestStatuses)]
    },
    expect: 'empty',
  }),
  'BookingRecordRepository.confirm': isolationCase({
    arrange: arrangeHeldBooking,
    act: (db, scope, ids) => new BookingRecordRepository(db, scope).confirm(ids.bookingId, { now: new Date(), confirmedBy: null, receiptToken: `t-${ids.bookingId}` }),
    expect: 'null',
    unchanged: async (db, ids) => {
      const [row] = await db.select().from(booking).where(eq(booking.id, ids.bookingId))
      if (row?.status !== 'HELD') throw new Error('org A booking was confirmed by org B')
    },
  }),
  'BookingRecordRepository.recordChange': isolationCase({
    arrange: arrangeHeldBooking,
    act: (db, scope, ids) => new BookingRecordRepository(db, scope).recordChange({ bookingId: ids.bookingId, kind: 'CONFIRMED', before: null, after: null, actor: { kind: 'system', id: null } }),
    expect: 'rejects',
    rejection: foreignKeyViolation,
  }),
  // Phase 2d pilgrim data (Organization scope): org B can neither read, write nor link org A's slots, copies and masters.
  'GuestRepository.statuses': isolationCase({ arrange: arrangeGuestDetail, act: (db, scope, ids) => new GuestRepository(db, scope).statuses(ids.bookingId), expect: 'empty' }),
  'BookingRecordRepository.findByReceiptToken': isolationCase({ arrange: arrangeConfirmedBooking, act: (db, scope, ids) => new BookingRecordRepository(db, scope).findByReceiptToken(ids.receiptToken), expect: 'null' }),
  'BookingRecordRepository.setStatus': isolationCase({ arrange: arrangeConfirmedBooking, act: (db, scope, ids) => new BookingRecordRepository(db, scope).setStatus(ids.bookingId, 'IN_HOUSE', new Date()), expect: 'null' }),
  'BookingRecordRepository.dueForDetailsReminder': isolationCase({ arrange: arrangeConfirmedBooking, act: (db, scope) => new BookingRecordRepository(db, scope).dueForDetailsReminder('2027-05-01', '2027-06-30', 10), expect: 'empty' }),
  'BookingRecordRepository.markDetailsReminded': isolationCase({ arrange: arrangeConfirmedBooking, act: async (db, scope, ids) => ((await new BookingRecordRepository(db, scope).markDetailsReminded(ids.bookingId, new Date())) ? 1 : 0), expect: 'zero-affected' }),
  'HotelTaskRepository.insertMany': isolationCase({
    // Org A's room and booking: only the organization can make the insert fail.
    arrange: arrangeConfirmedBooking,
    act: (db, scope, ids) => new HotelTaskRepository(db, scope).insertMany([{ hotelId: ids.hotelId, roomId: ids.roomId, bookingId: ids.bookingId, kind: 'EXTRA_BED_REMOVAL', quantity: 1, dueDate: '2027-06-06' }]),
    expect: 'rejects',
    rejection: foreignKeyViolation,
  }),
  'HotelTaskRepository.list': isolationCase({ arrange: arrangeConfirmedBooking, act: (db, scope, ids) => new HotelTaskRepository(db, scope).list({ hotelId: ids.hotelId, limit: 10 }), expect: 'empty' }),
  'HotelTaskRepository.findById': isolationCase({ arrange: arrangeConfirmedBooking, act: (db, scope, ids) => new HotelTaskRepository(db, scope).findById(ids.taskId, ids.hotelId), expect: 'null' }),
  'HotelTaskRepository.markDone': isolationCase({ arrange: arrangeConfirmedBooking, act: (db, scope, ids) => new HotelTaskRepository(db, scope).markDone(ids.taskId, ids.hotelId, { by: '00000000-0000-4000-8000-000000000000', at: new Date() }), expect: 'null' }),
  'GuestRepository.listForBooking': isolationCase({ arrange: arrangeGuestDetail, act: (db, scope, ids) => new GuestRepository(db, scope).listForBooking(ids.bookingId), expect: 'empty' }),
  'GuestRepository.findSlot': isolationCase({ arrange: arrangeGuestDetail, act: (db, scope, ids) => new GuestRepository(db, scope).findSlot(ids.bookingId, ids.guestId), expect: 'null' }),
  'GuestRepository.saveDetail': isolationCase({
    arrange: arrangeGuestDetail,
    act: (db, scope, ids) => new GuestRepository(db, scope).saveDetail({ bookingId: ids.bookingId, bookingGuestId: ids.guestId, fullName: 'Planted', enteredByKind: 'staff' }),
    expect: 'rejects',
    rejection: foreignKeyViolation,
    unchanged: async (db, ids) => {
      const [row] = await db.select().from(bookingGuestDetail).where(eq(bookingGuestDetail.id, ids.detailId))
      if (row?.fullName !== 'Pilgrim A') throw new Error('org A detail changed')
    },
  }),
  'GuestRepository.updateSlot': isolationCase({ arrange: arrangeGuestDetail, act: (db, scope, ids) => new GuestRepository(db, scope).updateSlot(ids.bookingId, ids.guestId, { status: 'READY' }), expect: 'null' }),
  'GuestRepository.passportOverlaps': isolationCase({ arrange: arrangeGuestDetail, act: (db, scope, ids) => new GuestRepository(db, scope).passportOverlaps([ids.lookup], { checkIn: '2027-01-01', checkOut: '2027-12-31' }, '00000000-0000-4000-8000-000000000000'), expect: 'empty' }),
  'PilgrimRepository.findByLookup': isolationCase({ arrange: arrangeGuestDetail, act: (db, scope, ids) => new PilgrimRepository(db, scope).findByLookup(ids.lookup), expect: 'null' }),
  // Org B's first sight of the same passport creates ITS master; it never returns or touches org A's.
  'PilgrimRepository.createIfAbsent': isolationCase({
    arrange: arrangeGuestDetail,
    act: async (db, scope, ids) => {
      const { row } = await new PilgrimRepository(db, scope).createIfAbsent({ fullName: 'Planted', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNoEncrypted: 'y', passportLookup: ids.lookup, passportExpiry: '2030-01-01' })
      return row.id === ids.pilgrimId ? [row] : []
    },
    expect: 'empty',
  }),
  'PiiAccessLogRepository.record': isolationCase({
    arrange: arrangeGuestDetail,
    act: async (db, scope, ids) => {
      await new PiiAccessLogRepository(db, scope).record([{ actorKind: 'staff', actorId: null, subjectType: 'BOOKING_GUEST_DETAIL', subjectId: ids.detailId, fields: ['passport_no'] }])
      const [detailRow] = await db.select().from(bookingGuestDetail).where(eq(bookingGuestDetail.id, ids.detailId))
      return db.select().from(piiAccessLog).where(eq(piiAccessLog.subjectId, ids.detailId)).then(rows => rows.filter(r => r.organizationId === detailRow!.organizationId))
    },
    expect: 'empty',
  }),
  'PassportScanRepository.insert': isolationCase({
    // A fresh image (one scan per image): only the organization can make the insert fail.
    arrange: async (db, orgA) => {
      const ids = await arrangeScan(db, orgA)
      const [asset] = await db.insert(documentAsset).values({ organizationId: orgA.organizationId, storageKey: `${orgA.organizationId}/2027/${ids.scanId}.png`, originalFilename: 'p2.png', mimeType: 'image/png', sizeBytes: 1, sha256: 'b'.repeat(64) }).returning()
      return { ...ids, documentId: asset!.id }
    },
    act: (db, scope, ids) => new PassportScanRepository(db, scope).insert({ bookingId: ids.bookingId, documentId: ids.documentId, status: 'QUEUED', uploadedByKind: 'agency' }),
    expect: 'rejects',
    rejection: foreignKeyViolation,
  }),
  'PassportScanRepository.findById': isolationCase({ arrange: arrangeScan, act: (db, scope, ids) => new PassportScanRepository(db, scope).findById(ids.scanId), expect: 'null' }),
  'PassportScanRepository.listForBooking': isolationCase({ arrange: arrangeScan, act: (db, scope, ids) => new PassportScanRepository(db, scope).listForBooking(ids.bookingId), expect: 'empty' }),
  'PassportScanRepository.startReading': isolationCase({ arrange: (db, orgA) => arrangeScan(db, orgA, 'QUEUED'), act: (db, scope, ids) => new PassportScanRepository(db, scope).startReading(ids.scanId, new Date()), expect: 'null' }),
  'PassportScanRepository.recordReading': isolationCase({
    arrange: (db, orgA) => arrangeScan(db, orgA, 'PROCESSING'),
    act: (db, scope, ids) => new PassportScanRepository(db, scope).recordReading(ids.scanId, { status: 'FAILED', method: null, extractedEncrypted: null, confidence: null, failureReason: 'UNREADABLE', bookingGuestId: null }, new Date()),
    expect: 'null',
  }),
  'PassportScanRepository.confirm': isolationCase({
    arrange: arrangeScan,
    act: (db, scope, ids) => new PassportScanRepository(db, scope).confirm(ids.scanId, { bookingGuestId: ids.guestId, bookingGuestDetailId: ids.detailId }, { reviewedByKind: 'staff', reviewedById: null, reviewedAt: new Date() }),
    expect: 'null',
  }),
  'PassportScanRepository.discard': isolationCase({ arrange: arrangeScan, act: (db, scope, ids) => new PassportScanRepository(db, scope).discard(ids.scanId, { reviewedByKind: 'staff', reviewedById: null, reviewedAt: new Date() }, '2027-01-01'), expect: 'null' }),
  'PassportScanRepository.clearReading': isolationCase({ arrange: arrangeScan, act: (db, scope, ids) => new PassportScanRepository(db, scope).clearReading(ids.scanId, new Date()), expect: 'null' }),
  'PassportScanRepository.countUnresolved': isolationCase({ arrange: arrangeScan, act: (db, scope, ids) => new PassportScanRepository(db, scope).countUnresolved(ids.bookingId), expect: 'zero-affected' }),
  'PassportScanRepository.imagesDue': isolationCase({
    arrange: async (db, orgA) => {
      const ids = await arrangeScan(db, orgA)
      await db.update(passportScan).set({ deleteAfter: '2027-01-01' }).where(eq(passportScan.id, ids.scanId))
      return ids
    },
    act: (db, scope) => new PassportScanRepository(db, scope).imagesDue('2099-12-31', new Date(), 10),
    expect: 'empty',
  }),
  'PassportScanRepository.targetedSlots': isolationCase({ arrange: arrangeScan, act: (db, scope, ids) => new PassportScanRepository(db, scope).targetedSlots(ids.bookingId), expect: 'empty' }),
  'BookingRecordRepository.lockOpenRequests': isolationCase({
    arrange: arrangeCustomerRequest,
    act: async (db, scope, ids) => db.transaction(tx => new BookingRecordRepository(tx, scope).lockOpenRequests(ids.customerId, new Date())),
    expect: 'zero-affected',
  }),
  // Phase 2a accounts (Organization scope): org B can neither read nor change org A's agencies and agency users,
  // and an insert can never land in org A.
  'AgencyRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new AgencyRepository(db, scope).insert({ organizationId: ids.orgAId, name: 'Planted', licenseNo: 'PLANTED', contactName: 'X', phone: '+966500000001', email: 'p@example.test' } as never)
      return db.select().from(agency).where(and(eq(agency.organizationId, ids.orgAId), eq(agency.licenseNo, 'PLANTED')))
    },
    expect: 'empty',
  }),
  'AgencyRepository.findById': isolationCase({
    arrange: arrangeAgencyUser,
    act: (db, scope, ids) => new AgencyRepository(db, scope).findById(ids.agencyId),
    expect: 'null',
  }),
  'AgencyRepository.findByLicenseNo': isolationCase({
    arrange: async (db, orgA) => ({ licenseNo: (await makeAgency(db, orgA)).licenseNo }),
    act: (db, scope, ids) => new AgencyRepository(db, scope).findByLicenseNo(ids.licenseNo),
    expect: 'null',
  }),
  'AgencyRepository.list': isolationCase({
    arrange: arrangeAgencyUser,
    act: async (db, scope) => (await new AgencyRepository(db, scope).list({ page: 1, pageSize: 50 })).rows,
    expect: 'empty',
  }),
  'AgencyRepository.setStatus': isolationCase({
    arrange: arrangeAgencyUser,
    act: async (db, scope, ids) => {
      await new AgencyRepository(db, scope).setStatus(ids.agencyId, { status: 'SUSPENDED', reason: 'planted', at: new Date(), by: ids.userId })
      return db.select().from(agency).where(and(eq(agency.id, ids.agencyId), eq(agency.status, 'SUSPENDED')))
    },
    expect: 'empty',
  }),
  'AgencyUserRepository.insert': isolationCase({
    arrange: arrangeAgencyUser,
    act: async (db, scope, ids) => {
      await new AgencyUserRepository(db, scope).insert({ organizationId: (await db.select().from(agency).where(eq(agency.id, ids.agencyId)))[0]!.organizationId, agencyId: ids.agencyId, email: 'planted@example.test', passwordHash: 'h', fullName: 'Planted' } as never).catch(() => null)
      return db.select().from(agencyUser).where(eq(agencyUser.email, 'planted@example.test'))
    },
    expect: 'empty',
  }),
  'AgencyUserRepository.findById': isolationCase({
    arrange: arrangeAgencyUser,
    act: (db, scope, ids) => new AgencyUserRepository(db, scope).findById(ids.userId),
    expect: 'null',
  }),
  'AgencyUserRepository.findByEmail': isolationCase({
    arrange: arrangeAgencyUser,
    act: (db, scope, ids) => new AgencyUserRepository(db, scope).findByEmail(ids.email),
    expect: 'null',
  }),
  'AgencyUserRepository.findActiveByEmail': isolationCase({
    arrange: arrangeAgencyUser,
    act: (db, scope, ids) => new AgencyUserRepository(db, scope).findActiveByEmail(ids.email),
    expect: 'null',
  }),
  'AgencyUserRepository.listByAgency': isolationCase({
    arrange: arrangeAgencyUser,
    act: (db, scope, ids) => new AgencyUserRepository(db, scope).listByAgency(ids.agencyId),
    expect: 'empty',
  }),
  'AgencyUserRepository.setActive': isolationCase({
    arrange: arrangeAgencyUser,
    act: async (db, scope, ids) => {
      await new AgencyUserRepository(db, scope).setActive(ids.userId, ids.agencyId, false, new Date())
      return db.select().from(agencyUser).where(and(eq(agencyUser.id, ids.userId), eq(agencyUser.isActive, false)))
    },
    expect: 'empty',
  }),
  'AgencyUserRepository.recordLogin': isolationCase({
    arrange: arrangeAgencyUser,
    act: async (db, scope, ids) => {
      await new AgencyUserRepository(db, scope).recordLogin(ids.userId, new Date())
      return db.select().from(agencyUser).where(and(eq(agencyUser.id, ids.userId), isNotNull(agencyUser.lastLoginAt)))
    },
    expect: 'empty',
  }),
  'CustomerRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new CustomerRepository(db, scope).insert({ organizationId: ids.orgAId, fullName: 'Planted', phone: '+966599999999' } as never)
      return db.select().from(customer).where(and(eq(customer.organizationId, ids.orgAId), eq(customer.phone, '+966599999999')))
    },
    expect: 'empty',
  }),
  'CustomerRepository.findById': isolationCase({
    arrange: arrangeCustomerChallenge,
    act: (db, scope, ids) => new CustomerRepository(db, scope).findById(ids.customerId),
    expect: 'null',
  }),
  'CustomerRepository.findByPhone': isolationCase({
    arrange: arrangeCustomerChallenge,
    act: (db, scope, ids) => new CustomerRepository(db, scope).findByPhone(ids.phone),
    expect: 'null',
  }),
  'CustomerRepository.recordLogin': isolationCase({
    arrange: arrangeCustomerChallenge,
    act: async (db, scope, ids) => {
      await new CustomerRepository(db, scope).recordLogin(ids.customerId, new Date())
      return db.select().from(customer).where(and(eq(customer.id, ids.customerId), isNotNull(customer.lastLoginAt)))
    },
    expect: 'empty',
  }),
  'OtpChallengeRepository.insert': isolationCase({
    arrange: async (_db, orgA) => ({ orgAId: orgA.organizationId }),
    act: async (db, scope, ids) => {
      await new OtpChallengeRepository(db, scope).insert({ organizationId: ids.orgAId, phone: '+966599999998', codeHash: 'b'.repeat(64), expiresAt: new Date() } as never)
      return db.select().from(otpChallenge).where(and(eq(otpChallenge.organizationId, ids.orgAId), eq(otpChallenge.phone, '+966599999998')))
    },
    expect: 'empty',
  }),
  'OtpChallengeRepository.registerAttempt': isolationCase({
    arrange: arrangeCustomerChallenge,
    act: (db, scope, ids) => new OtpChallengeRepository(db, scope).registerAttempt(ids.challengeId, new Date(), 5),
    expect: 'null',
  }),
  'OtpChallengeRepository.closeOpenForPhone': isolationCase({
    arrange: arrangeCustomerChallenge,
    act: async (db, scope, ids) => {
      await new OtpChallengeRepository(db, scope).closeOpenForPhone(ids.phone, new Date())
      return db.select().from(otpChallenge).where(and(eq(otpChallenge.id, ids.challengeId), isNotNull(otpChallenge.consumedAt)))
    },
    expect: 'empty',
  }),
  'CustomerRepository.bumpSessionVersion': isolationCase({
    arrange: arrangeCustomerChallenge,
    act: async (db, scope, ids) => {
      await new CustomerRepository(db, scope).bumpSessionVersion(ids.customerId)
      return db.select().from(customer).where(and(eq(customer.id, ids.customerId), eq(customer.sessionVersion, 2)))
    },
    expect: 'empty',
  }),
  'OtpChallengeRepository.consume': isolationCase({
    arrange: arrangeCustomerChallenge,
    act: async (db, scope, ids) => (await new OtpChallengeRepository(db, scope).consume(ids.challengeId, new Date())) ? 1 : 0,
    expect: 'zero-affected',
  }),
  ...ruleCases('RateRepository', RateRepository, rate, (ids, second) => ({ roomTypeId: ids.roomTypeId, priceType: 'PUBLIC', unit: 'PER_PERSON_NIGHT', startDate: second ? '2027-02-01' : '2027-01-01', endDate: second ? '2027-02-28' : '2027-01-31', amountHalalas: 38000, vatIncluded: true }), { amountHalalas: 1 }),
  ...ruleCases('AgencyQuotaRepository', AgencyQuotaRepository, agencyQuota, (ids, second) => ({ agencyId: ids.agencyId, startDate: second ? '2027-02-01' : '2027-01-01', endDate: second ? '2027-02-28' : '2027-01-31', maxPersons: 30 }), { maxPersons: 1 }),
  ...ruleCases('AllocationRuleRepository', AllocationRuleRepository, allocationRule, (_ids, second) => ({ groupMin: second ? 11 : 1, groupMax: second ? 20 : 10, minSeats: 5, maxRooms: 1 }), { maxRooms: 9 }),
  ...ruleCases('ExtraBedPolicyRepository', ExtraBedPolicyRepository, extraBedPolicy, ids => ({ roomTypeId: ids.roomTypeId, maxPerRoom: 1, maxPerBooking: 2, amountHalalas: 8000, vatIncluded: true, allowInOverrideSeason: false }), { maxPerRoom: 2 }),
  // Booking settings (Organization scope): org B's ensure/update never see or change org A's row.
  'BookingSettingRepository.ensure': isolationCase({
    arrange: async (db, orgA) => { await db.insert(bookingSetting).values({ organizationId: orgA.organizationId, holdMinutes: 33 }); return {} },
    act: async (db, scope) => [await new BookingSettingRepository(db, scope).ensure()].filter(row => row.holdMinutes === 33),
    expect: 'empty',
  }),
  'BookingSettingRepository.ensureForUpdate': isolationCase({
    arrange: async (db, orgA) => { await db.insert(bookingSetting).values({ organizationId: orgA.organizationId, holdMinutes: 33 }); return {} },
    act: (db, scope) => db.transaction(async tx => [await new BookingSettingRepository(tx, scope).ensureForUpdate()].filter(row => row.holdMinutes === 33)),
    expect: 'empty',
  }),
  'BookingSettingRepository.update': isolationCase({
    arrange: async (db, orgA) => { await db.insert(bookingSetting).values({ organizationId: orgA.organizationId }); return { orgAId: orgA.organizationId } },
    act: async (db, scope, ids) => {
      await new BookingSettingRepository(db, scope).update({ holdMinutes: 77 }, '00000000-0000-4000-8000-000000000000', new Date())
      return db.select().from(bookingSetting).where(and(eq(bookingSetting.organizationId, ids.orgAId), eq(bookingSetting.holdMinutes, 77)))
    },
    expect: 'empty',
  }),
  'PriceQuoteRepository.insert': isolationCase({
    arrange: arrangeQuote,
    act: async (db, scope, ids) => {
      await new PriceQuoteRepository(db, scope).insert({ organizationId: (await db.select().from(agency).where(eq(agency.id, ids.agencyId)))[0]!.organizationId, refNo: 'Q-PLANTED', agencyId: ids.agencyId, hotelId: ids.hotelId, bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-02', totalCount: 1 } as never).catch(() => null)
      return db.select().from(priceQuote).where(eq(priceQuote.refNo, 'Q-PLANTED'))
    },
    expect: 'empty',
  }),
  'PriceQuoteRepository.findById': isolationCase({ arrange: arrangeQuote, act: (db, scope, ids) => new PriceQuoteRepository(db, scope).findById(ids.quoteId), expect: 'null' }),
  'PriceQuoteRepository.list': isolationCase({ arrange: arrangeQuote, act: async (db, scope) => (await new PriceQuoteRepository(db, scope).list({ page: 1, pageSize: 50 })).rows, expect: 'empty' }),
  'PriceQuoteRepository.setOffer': isolationCase({
    arrange: arrangeQuote,
    act: (db, scope, ids) => new PriceQuoteRepository(db, scope).setOffer(ids.quoteId, { amountHalalas: 1, unit: 'PER_PERSON_NIGHT', vatIncluded: true, validUntil: new Date(), offeredBy: ids.agencyId, offeredAt: new Date() }),
    expect: 'null',
  }),
  'PriceQuoteRepository.markAccepted': isolationCase({ arrange: (db, orgA) => arrangeQuote(db, orgA, true), act: (db, scope, ids) => new PriceQuoteRepository(db, scope).markAccepted(ids.quoteId, new Date()), expect: 'null' }),
  'PriceQuoteRepository.setStatus': isolationCase({ arrange: arrangeQuote, act: (db, scope, ids) => new PriceQuoteRepository(db, scope).setStatus(ids.quoteId, 'DECLINED', new Date()), expect: 'null' }),
  'PriceQuoteRepository.expireOffered': isolationCase({
    arrange: (db, orgA) => arrangeQuote(db, orgA, true),
    act: (db, scope) => new PriceQuoteRepository(db, scope).expireOffered(new Date()),
    expect: 'zero-affected',
  }),
  'DocumentSequenceRepository.next': isolationCase({
    arrange: async (db, orgA) => { await db.insert(documentSequence).values({ organizationId: orgA.organizationId, kind: 'QUOTE', year: 2027, lastValue: 41 }); return {} },
    act: async (db, scope) => ((await new DocumentSequenceRepository(db, scope).next('QUOTE', 2027)) === 42 ? 1 : 0),
    expect: 'zero-affected',
  }),
  'HotelDocumentRepository.list': isolationCase({
    arrange: (db, orgA) => arrangeDocument(db, orgA, true),
    act: async (db, scope, ids) => {
      const repo = new HotelDocumentRepository(db, trustedHotelScope(scope, ids.hotelId))
      return [...(await repo.list({ includeArchived: true, page: 1, pageSize: 50 })).rows, ...(await repo.list({ includeArchived: false, page: 1, pageSize: 50 })).rows]
    },
    expect: 'empty',
  }),
}

export function registryCases(): Array<{ key: string, case: AnyCase }> {
  return Object.entries(ISOLATION_REGISTRY).flatMap(([key, entry]) => [entry].flat().map(c => ({ key: c.name ? `${key} (${c.name})` : key, case: c })))
}

/** `ClassName.method` for every prototype method (inherited ones included) of every exported `*Repository` class. */
export function repositoryMethodKeys(barrels: ReadonlyArray<Record<string, unknown>>): string[] {
  const keys = new Set<string>()
  for (const barrel of barrels) {
    for (const [name, value] of Object.entries(barrel)) {
      if (!name.endsWith('Repository') || typeof value !== 'function') continue
      for (let proto = value.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const method of Object.getOwnPropertyNames(proto)) {
          if (method === 'constructor') continue
          if (typeof Object.getOwnPropertyDescriptor(proto, method)?.value === 'function') keys.add(`${name}.${method}`)
        }
      }
    }
  }
  return [...keys].sort()
}

export function coverageGaps(barrels: ReadonlyArray<Record<string, unknown>>, registry: Record<string, unknown>): { missing: string[], stale: string[] } {
  const methods = repositoryMethodKeys(barrels)
  const registered = Object.keys(registry)
  return {
    missing: methods.filter(k => !registered.includes(k)),
    stale: registered.filter(k => !methods.includes(k)).sort(),
  }
}
