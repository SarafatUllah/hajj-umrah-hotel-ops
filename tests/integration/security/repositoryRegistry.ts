import { and, eq } from 'drizzle-orm'
import { appUser, auditLog, floor, hotel, hotelSetting, room, roomBaseConfig, roomType, role, rolePermission, userHotelAccess, userRole } from '../../../db/schema'
import type { DbOrTx } from '../../../db/client'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { AuditRepository, HotelRepository, RoleNotInScopeError, RoleRepository, RoomTypeRepository, TenantOrganizationRepository, UserHotelAccessRepository, UserRepository } from '../../../server/repositories/tenant'
import { FloorRepository, HotelSettingRepository, RoomBaseConfigRepository, RoomRepository } from '../../../server/repositories/hotel'
import { ensurePermissions, makeFloor, makeHotel, makeRole, makeRoom, makeRoomType, makeRoomWithVersion, makeUser, makeUserWithPermissions } from '../../support/fixtures'

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

async function assertNoRows(rows: unknown[], what: string) {
  if (rows.length !== 0) throw new Error(`${what}: expected no rows, found ${rows.length}`)
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
  'RoomRepository.findById': isolationCase({
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
