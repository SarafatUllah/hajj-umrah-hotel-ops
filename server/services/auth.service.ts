import { and, eq } from 'drizzle-orm'
import { useDb } from '../utils/db'
import { organization, appUser, role, rolePermission, userRole } from '../../db/schema'
import { verifyPassword, TIMING_SAFETY_DUMMY_HASH } from '../utils/password'
import { normalizeEmail } from '../../shared/utils/email'

export interface AuthenticatedUser {
  id: string
  organizationId: string
  email: string
  fullName: string
}

export interface AuthenticationResult {
  user: AuthenticatedUser
  permissions: string[]
  allHotels: boolean
  hotelIds: string[]
}

/**
 * Tenant-scoped login: email is unique only within an organization
 * (app_user_org_email_unique), not globally, so the organization must be
 * resolved first — a lookup by email alone could match a same-named user
 * in a different organization and authenticate against the wrong tenant.
 */
export async function authenticate(organizationSlug: string, email: string, password: string): Promise<AuthenticationResult | null> {
  const db = useDb()

  const [org] = await db.select().from(organization).where(eq(organization.slug, organizationSlug)).limit(1)

  const [foundUser] = org
    ? await db
        .select()
        .from(appUser)
        .where(and(
          eq(appUser.organizationId, org.id),
          eq(appUser.email, normalizeEmail(email)),
          eq(appUser.isActive, true),
        ))
        .limit(1)
    : []

  // Always run exactly one Argon2 verify, whether or not the organization
  // and user exist, so "unknown organization", "unknown email", and "wrong
  // password" are indistinguishable by response time as well as by message.
  const passwordOk = await verifyPassword(password, foundUser?.passwordHash ?? TIMING_SAFETY_DUMMY_HASH)
  if (!org || !foundUser || !passwordOk) return null

  // role.organization_id is checked in addition to the user_role link, so a
  // user_role row pointing at another tenant's role (which should never
  // exist, but nothing in the schema forbids it) can never grant permissions
  // across an organization boundary.
  const permissionRows = await db
    .select({ permissionKey: rolePermission.permissionKey })
    .from(userRole)
    .innerJoin(role, eq(role.id, userRole.roleId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(and(
      eq(userRole.userId, foundUser.id),
      eq(role.organizationId, foundUser.organizationId),
    ))

  const permissions = Array.from(new Set(permissionRows.map(r => r.permissionKey)))

  return {
    user: {
      id: foundUser.id,
      organizationId: foundUser.organizationId,
      email: foundUser.email,
      fullName: foundUser.fullName,
    },
    permissions,
    // Hotel access (user_hotel_access) arrives in Phase 1 alongside the
    // hotel table. Until then, every authenticated user has no hotel scope.
    allHotels: false,
    hotelIds: [],
  }
}
