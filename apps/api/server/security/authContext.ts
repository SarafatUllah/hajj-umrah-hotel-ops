import type { Database } from '@hajj/db/client'
import type { AuthorizationContext } from '../domain/rbac/hasPermission'
import type { Permission } from '@hajj/contracts/constants/permissions'
import { tenantRepos } from '../repositories'
import { trustedOrganizationScope, type OrganizationScope } from './scope'

/** The bare identity tuple a verified session carries — never a permission/hotel-access snapshot. */
export interface AuthIdentity {
  userId: string
  organizationId: string
  email: string
  fullName: string
}

export interface AuthContext {
  identity: AuthIdentity
  authz: AuthorizationContext
  scope: OrganizationScope
  db: Database
  now: () => Date
  /**
   * True when STAFF_2FA_ENFORCEMENT=required-roles, the user holds a role that requires two-factor
   * authentication and has not enrolled yet: only the auth/2FA routes may then be used. Absent = false.
   */
  twoFactorEnrollmentPending?: boolean
}

/**
 * Resolves authorization from the database, fresh, on every call — nothing about permissions,
 * `allHotels`, or hotel access is ever cached across requests. Returns `null` when the user does not
 * exist in `identity.organizationId`, is inactive, has been deleted, or (when the session carries one) the
 * session's version is no longer the user's current one; a caller must treat `null` as
 * "no valid session" (see `requireAuthContext`), never retry with a fallback.
 *
 * Exactly three queries: the user row (org + id scoped), the user's current permission keys, and the
 * user's current hotel ids. `is_active` is checked in code rather than in SQL so `UserRepository.findById`
 * stays a single, general-purpose lookup — this is still exactly one query for the user.
 */
export async function resolveAuthContext(
  db: Database,
  identity: { userId: string, organizationId: string, sessionVersion?: number },
  now: () => Date = () => new Date(),
  options: { enforceTwoFactor?: boolean } = {},
): Promise<AuthContext | null> {
  // Scoped to identity.organizationId: a user id that belongs to a different organization (or does
  // not exist at all) resolves to null here, exactly like a deleted user — the two are
  // indistinguishable by design (D-invariant: no existence leak across organizations).
  const scope = trustedOrganizationScope(identity.organizationId)
  const repos = tenantRepos(db, scope)

  const user = await repos.users.findById(identity.userId)
  if (!user || !user.isActive) return null
  // A session minted before the user's last 2FA change (enable, disable, admin reset) is no longer valid.
  if (identity.sessionVersion !== undefined && identity.sessionVersion !== user.sessionVersion) return null

  const [permissionKeys, hotelIds] = await Promise.all([
    repos.roles.permissionKeysForUser(user.id),
    repos.userHotelAccess.hotelIdsForUser(user.id),
  ])
  // One extra query, only for a user who has not enrolled while enforcement is on.
  const twoFactorEnrollmentPending = options.enforceTwoFactor === true && user.totpEnabledAt === null
    ? await repos.roles.requiresTwoFactorForUser(user.id)
    : false

  return {
    identity: {
      userId: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
    },
    authz: {
      permissions: new Set(permissionKeys as Permission[]),
      allHotels: user.allHotels,
      hotelIds: new Set(hotelIds),
    },
    scope,
    db,
    now,
    twoFactorEnrollmentPending,
  }
}
