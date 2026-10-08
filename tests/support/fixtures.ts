import { randomUUID } from 'node:crypto'
import type { DbOrTx } from '../../db/client'
import { hotelRepos, platformRepos, tenantRepos } from '../../server/repositories'
import type { CapacityPeriodRow, FloorRow, HotelDocumentRow, NewCapacityPeriod, NewFloor, NewRoom, NewRoomBaseConfig, NewRoomCapacityOverride, NewRoomOperationalBlock, RoomBaseConfigRow, RoomCapacityOverrideRow, RoomOperationalBlockRow, RoomRow } from '../../server/repositories/hotel'
import type { NewOrganization, OrganizationRow } from '../../server/repositories/platform/organizationRepository'
import type { DocumentAssetRow, HotelRow, NewDocumentAsset, NewHotel, NewRoomType, NewUser, RoleRow, RoomTypeRow, UserRow } from '../../server/repositories/tenant'
import { trustedOrganizationScope, type HotelScope, type OrganizationScope } from '../../server/security/scope'

/**
 * Test fixtures, created through the same repositories production code uses (extended by later
 * tasks: hotels, floors, rooms, …). Every default is unique per call so fixtures never collide.
 */

let sequence = 0
const next = () => `${++sequence}-${randomUUID().slice(0, 8)}`

export async function makeOrg(db: DbOrTx, overrides: Partial<NewOrganization> = {}): Promise<{ organization: OrganizationRow, scope: OrganizationScope }> {
  const n = next()
  const organization = await platformRepos(db).organizations.insert({ name: `Org ${n}`, slug: `org-${n}`, ...overrides })
  return { organization, scope: trustedOrganizationScope(organization.id) }
}

export interface MakeUserOptions extends Partial<NewUser> {
  /** Grants access to these hotels via user_hotel_access, after the user is created. */
  hotelIds?: readonly string[]
}

export async function makeUser(db: DbOrTx, scope: OrganizationScope, options: MakeUserOptions = {}): Promise<UserRow> {
  const { hotelIds, ...overrides } = options
  const n = next()
  const user = await tenantRepos(db, scope).users.insert({ email: `user-${n}@example.test`, passwordHash: 'not-a-real-hash', fullName: `User ${n}`, ...overrides })
  if (hotelIds?.length) await tenantRepos(db, scope).userHotelAccess.replaceForUser(user.id, hotelIds, null)
  return user
}

export async function makeHotel(db: DbOrTx, scope: OrganizationScope, overrides: Partial<NewHotel> = {}): Promise<HotelRow> {
  const n = next()
  return tenantRepos(db, scope).hotels.insert({ code: `HTL-${n}`, name: `Hotel ${n}`, city: 'Makkah', ...overrides })
}

/**
 * Caller mints the `HotelScope` itself (e.g. `trustedHotelScope(orgScope, hotel.id)`), matching the
 * existing `HotelSettingRepository` fixture pattern. Default `level` cycles through -5..184 (bounded,
 * so it always satisfies the -5..200 check constraint even after many fixture calls in one test file).
 */
export async function makeFloor(db: DbOrTx, hotelScope: HotelScope, overrides: Partial<NewFloor> = {}): Promise<FloorRow> {
  const n = sequence++
  const level = overrides.level ?? (n % 190) - 5
  return hotelRepos(db, hotelScope).floors.insert({ level, label: `Floor ${level}`, ...overrides })
}

export async function makeRoomType(db: DbOrTx, scope: OrganizationScope, overrides: Partial<NewRoomType> = {}): Promise<RoomTypeRow> {
  const n = next()
  return tenantRepos(db, scope).roomTypes.insert({
    code: `RT-${n.replace(/-/g, '').slice(0, 15).toUpperCase()}`,
    name: `Room Type ${n}`,
    defaultPhysicalBeds: 4,
    defaultSellableCapacity: 4,
    ...overrides,
  })
}

/** Room number defaults to a fresh unique value per call (never colliding within a test's hotel). */
export async function makeRoom(db: DbOrTx, hotelScope: HotelScope, floorId: string, roomTypeId: string, overrides: Partial<NewRoom> = {}): Promise<RoomRow> {
  const n = sequence++
  return hotelRepos(db, hotelScope).rooms.insert({
    floorId,
    roomTypeId,
    roomNumber: `R${n}`,
    features: [],
    notes: null,
    ...overrides,
  })
}

/** A room's initial (or any additional) base-config version — `origin` defaults to `'SEED'` (test data, not created through the create-room service). */
export async function makeRoomBaseConfig(db: DbOrTx, hotelScope: HotelScope, roomId: string, overrides: Partial<NewRoomBaseConfig> = {}): Promise<RoomBaseConfigRow> {
  return hotelRepos(db, hotelScope).roomBaseConfigs.insert({
    roomId,
    validFrom: '2025-01-01',
    validTo: null,
    physicalBeds: 4,
    sellableCapacity: 4,
    origin: 'SEED',
    ...overrides,
  })
}

/** A room WITH its initial base version in one call — the common case for tests that don't care about the two-step insert itself. */
export async function makeRoomWithVersion(db: DbOrTx, hotelScope: HotelScope, floorId: string, roomTypeId: string, overrides: Partial<NewRoom> = {}, versionOverrides: Partial<NewRoomBaseConfig> = {}): Promise<{ room: RoomRow, baseVersion: RoomBaseConfigRow }> {
  const room = await makeRoom(db, hotelScope, floorId, roomTypeId, overrides)
  const baseVersion = await makeRoomBaseConfig(db, hotelScope, room.id, versionOverrides)
  return { room, baseVersion }
}

/** A capacity period — `startDate`/`endDate` default to a far-future Hajj-shaped window so it starts out FUTURE (overrides addable) unless overridden. */
export async function makeCapacityPeriod(db: DbOrTx, hotelScope: HotelScope, overrides: Partial<NewCapacityPeriod> = {}): Promise<CapacityPeriodRow> {
  const n = next()
  return hotelRepos(db, hotelScope).capacityPeriods.insert({
    name: `Period ${n}`,
    kind: 'HAJJ',
    startDate: '2027-05-01',
    endDate: '2027-07-31',
    notes: null,
    ...overrides,
  })
}

/** A room's override for one capacity period — dates default to the whole `2027-05-01..2027-07-31` Hajj window (matching `makeCapacityPeriod`'s default); pass the SAME dates as the period when the FK matters. */
export async function makeRoomCapacityOverride(db: DbOrTx, hotelScope: HotelScope, roomId: string, periodId: string, overrides: Partial<NewRoomCapacityOverride> = {}): Promise<RoomCapacityOverrideRow> {
  const [row] = await hotelRepos(db, hotelScope).roomCapacityOverrides.insertMany([{
    roomId,
    periodId,
    validFrom: '2027-05-01',
    validTo: '2027-07-31',
    physicalBeds: 6,
    sellableCapacity: 6,
    reason: null,
    ...overrides,
  }])
  return row!
}

/** An ACTIVE operational block written straight through the repository (no service rules) — defaults to a 5-night MAINTENANCE block in 2027. */
export async function makeRoomBlock(db: DbOrTx, hotelScope: HotelScope, roomId: string, overrides: Partial<NewRoomOperationalBlock> = {}): Promise<RoomOperationalBlockRow> {
  return hotelRepos(db, hotelScope).operationalBlocks.insert({
    roomId,
    kind: 'MAINTENANCE',
    startDate: '2027-05-01',
    endDate: '2027-05-05',
    reason: 'Fixture block',
    ...overrides,
  })
}

/**
 * A document asset + its hotel_document row written straight through the repositories (no storage
 * object, no service rules). The storage key is unique per call and has the production shape.
 */
export async function makeHotelDocument(
  db: DbOrTx,
  hotelScope: HotelScope,
  overrides: Partial<NewDocumentAsset> & { docType?: string, title?: string, description?: string | null } = {},
): Promise<{ asset: DocumentAssetRow, document: HotelDocumentRow }> {
  const { docType, title, description, ...assetOverrides } = overrides
  const asset = await tenantRepos(db, hotelScope).documentAssets.insert({
    storageKey: `${hotelScope.organizationId}/2026/${randomUUID()}.pdf`,
    originalFilename: 'fixture.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1234,
    sha256: 'a'.repeat(64),
    uploadedBy: null,
    ...assetOverrides,
  })
  const document = await hotelRepos(db, hotelScope).hotelDocuments.insert({ documentId: asset.id, docType: docType ?? 'LICENSE', title: title ?? 'Fixture document', description: description ?? null })
  return { asset, document }
}

/** Adds the permission keys missing from the global catalog (existing descriptions are left alone). */
export async function ensurePermissions(db: DbOrTx, keys: readonly string[]): Promise<void> {
  const catalog = platformRepos(db).permissionCatalog
  const existing = new Set(await catalog.listKeys())
  const missing = keys.filter(k => !existing.has(k))
  if (missing.length > 0) await catalog.upsertAll(missing.map(key => ({ key, description: `Test permission ${key}` })))
}

export async function makeRole(db: DbOrTx, scope: OrganizationScope, options: { key?: string, name?: string, permissions?: readonly string[] } = {}): Promise<RoleRow> {
  const n = next()
  const roles = tenantRepos(db, scope).roles
  const created = await roles.insert({ key: options.key ?? `ROLE_${n.replace(/-/g, '_').toUpperCase()}`, name: options.name ?? `Role ${n}` })
  if (options.permissions?.length) {
    await ensurePermissions(db, options.permissions)
    await roles.grantPermissions(created.id, options.permissions)
  }
  return created
}

/** A user holding one role with the given permissions. */
export async function makeUserWithPermissions(db: DbOrTx, scope: OrganizationScope, permissions: readonly string[], overrides: Partial<NewUser> = {}): Promise<{ user: UserRow, role: RoleRow }> {
  const user = await makeUser(db, scope, overrides)
  const role = await makeRole(db, scope, { permissions })
  await tenantRepos(db, scope).roles.assignToUser(user.id, role.id)
  return { user, role }
}
