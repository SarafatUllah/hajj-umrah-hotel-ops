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
}

/**
 * Tenant-scoped login: email is unique only within an organization
 * (app_user_org_email_unique), not globally, so the organization must be
 * resolved first — a lookup by email alone could match a same-named user
 * in a different organization and authenticate against the wrong tenant.
 *
 * Identity only (Task 7): authorization (permissions, allHotels, hotelIds) is never resolved here
 * and never stored in the session — every request resolves it fresh via resolveAuthContext.
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

  return {
    user: {
      id: foundUser.id,
      organizationId: foundUser.organizationId,
      email: foundUser.email,
      fullName: foundUser.fullName,
    },
  }
}
