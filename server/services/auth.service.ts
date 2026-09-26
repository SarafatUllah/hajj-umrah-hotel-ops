import { useDb } from '../utils/db'
import { tenantRepos } from '../repositories'
import { resolveTenantBySlug } from '../security/tenantResolver'
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

  const tenant = await resolveTenantBySlug(db, organizationSlug)
  const repos = tenant ? tenantRepos(db, tenant.scope) : null
  const foundUser = repos ? await repos.users.findActiveByEmail(normalizeEmail(email)) : null

  // Always run exactly one Argon2 verify, whether or not the organization
  // and user exist, so "unknown organization", "unknown email", and "wrong
  // password" are indistinguishable by response time as well as by message.
  const passwordOk = await verifyPassword(password, foundUser?.passwordHash ?? TIMING_SAFETY_DUMMY_HASH)
  if (!repos || !foundUser || !passwordOk) return null

  // Cross-organization grants are blocked twice: the composite foreign keys
  // on user_role (migration 0001) reject a link between a user and a role of
  // different organizations, and permissionKeysForUser independently
  // requires role.organization_id to be this tenant's organization.
  const permissions = await repos.roles.permissionKeysForUser(foundUser.id)

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
