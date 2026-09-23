import { and, eq } from 'drizzle-orm'
import { useDb } from '../utils/db'
import { organization, appUser, role, rolePermission, userRole } from '../../db/schema'
import { verifyPassword } from '../utils/password'

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
  if (!org) return null

  const [foundUser] = await db
    .select()
    .from(appUser)
    .where(and(
      eq(appUser.organizationId, org.id),
      eq(appUser.email, email),
      eq(appUser.isActive, true),
    ))
    .limit(1)

  if (!foundUser) return null
  if (!(await verifyPassword(password, foundUser.passwordHash))) return null

  const permissionRows = await db
    .select({ permissionKey: rolePermission.permissionKey })
    .from(userRole)
    .innerJoin(role, eq(role.id, userRole.roleId))
    .innerJoin(rolePermission, eq(rolePermission.roleId, role.id))
    .where(eq(userRole.userId, foundUser.id))

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
