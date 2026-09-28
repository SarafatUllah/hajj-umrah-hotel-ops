import { randomUUID } from 'node:crypto'
import type { DbOrTx } from '../../db/client'
import { platformRepos, tenantRepos } from '../../server/repositories'
import type { NewOrganization, OrganizationRow } from '../../server/repositories/platform/organizationRepository'
import type { HotelRow, NewHotel, NewUser, RoleRow, UserRow } from '../../server/repositories/tenant'
import { trustedOrganizationScope, type OrganizationScope } from '../../server/security/scope'

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
