import { eq } from 'drizzle-orm'
import { appUser } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { tenantRepos } from '../../../server/repositories'
import type { OrganizationScope } from '../../../server/security/scope'
import type { UserRow } from '../../../server/repositories/tenant'
import { hashPassword } from '../../../server/utils/password'
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, DEMO_ORG_SLUG, seedDemoOrganization } from '../../../db/seed/demo-org'
import { seedOrganizationRoles, seedPermissionCatalog } from '../../../db/seed/rbac'
import { closeTestDb, getTestDb, truncateAllTables } from '../../integration/support/testDb'
import { ensurePermissions, makeHotel, makeOrg, makeRole, makeRoomType, makeUser, makeUserWithPermissions, type MakeUserOptions } from '../../support/fixtures'

/**
 * HTTP-suite test data, built through the same repositories/seed modules the rest of the codebase
 * uses (tests/support/fixtures.ts for org/user/hotel/role creation, db/seed/** for the demo
 * organization/RBAC catalog) against a real DB connection — this file adds only what plain
 * service-level fixtures don't need: a real (loginable) password hash, and direct mutation helpers
 * for proving Task 7's freshness guarantee over HTTP (S3).
 */
export {
  closeTestDb,
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_ORG_SLUG,
  ensurePermissions,
  getTestDb as getHttpTestDb,
  makeHotel,
  makeOrg,
  makeRole,
  makeRoomType,
  makeUser,
  makeUserWithPermissions,
  seedDemoOrganization,
  seedOrganizationRoles,
  seedPermissionCatalog,
  truncateAllTables,
}

/** Default password for makeLoginableUser() callers that don't care what it is. */
export const HTTP_TEST_PASSWORD = 'Http-Test-Passw0rd!'

/**
 * makeUser() defaults to a placeholder (non-verifiable) passwordHash, since most fixtures never log
 * in over HTTP. HTTP tests need a real Argon2 hash so `POST /api/auth/login` can authenticate it.
 */
export async function makeLoginableUser(
  db: Database,
  scope: OrganizationScope,
  options: Omit<MakeUserOptions, 'passwordHash'> & { password?: string } = {},
): Promise<{ user: UserRow, password: string }> {
  const { password = HTTP_TEST_PASSWORD, ...overrides } = options
  const passwordHash = await hashPassword(password)
  const user = await makeUser(db, scope, { ...overrides, passwordHash })
  return { user, password }
}

/** Direct DB mutation (no service layer) — proves Task 7 never trusts a session-cached snapshot. */
export async function setUserActive(db: Database, userId: string, isActive: boolean): Promise<void> {
  await db.update(appUser).set({ isActive }).where(eq(appUser.id, userId))
}

export async function setAllHotels(db: Database, scope: OrganizationScope, userId: string, value: boolean): Promise<void> {
  await tenantRepos(db, scope).users.setAllHotels(userId, value)
}

export async function removeAllHotelAccess(db: Database, scope: OrganizationScope, userId: string): Promise<void> {
  await tenantRepos(db, scope).userHotelAccess.replaceForUser(userId, [], null)
}

/** Assigns a role to a user via the same repository production code uses (RoleRepository.assignToUser). */
export async function assignRole(db: Database, scope: OrganizationScope, userId: string, roleId: string): Promise<void> {
  await tenantRepos(db, scope).roles.assignToUser(userId, roleId)
}
