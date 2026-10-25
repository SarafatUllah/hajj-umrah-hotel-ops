import type { Database } from '@hajj/db/client'
import type { AgencyStatus } from '@hajj/contracts/constants/accounts'
import { accountsRepos } from '../repositories'
import { trustedAgencyScope, trustedOrganizationScope, type AgencyScope } from './scope'

/** The bare identity an agency-portal session carries. */
export interface AgencyIdentity {
  agencyUserId: string
  agencyId: string
  organizationId: string
  email: string
  fullName: string
}

/** A signed-in agency user, resolved fresh on every request (never trusted from the session). */
export interface AgencyContext {
  identity: AgencyIdentity
  agency: { id: string, name: string, status: AgencyStatus }
  scope: AgencyScope
  db: Database
  now: () => Date
}

/**
 * Resolves an agency-portal session against the database: the user must exist in the organization, be active,
 * still belong to the session's agency and carry the current session version (a deactivation ends every session).
 * `null` = no valid session. The agency's status is read fresh too; business routes require APPROVED
 * (`requireApprovedAgency`), the portal's own `me` does not, so a pending agency can see where it stands.
 */
export async function resolveAgencyContext(
  db: Database,
  identity: { agencyUserId: string, organizationId: string, agencyId: string, sessionVersion?: number },
  now: () => Date = () => new Date(),
): Promise<AgencyContext | null> {
  const repos = accountsRepos(db, trustedOrganizationScope(identity.organizationId))
  const user = await repos.agencyUsers.findById(identity.agencyUserId)
  if (!user || !user.isActive || user.agencyId !== identity.agencyId) return null
  if (identity.sessionVersion !== undefined && identity.sessionVersion !== user.sessionVersion) return null
  const agencyRow = await repos.agencies.findById(user.agencyId)
  if (!agencyRow) return null

  const orgScope = trustedOrganizationScope(user.organizationId)
  return {
    identity: { agencyUserId: user.id, agencyId: user.agencyId, organizationId: user.organizationId, email: user.email, fullName: user.fullName },
    agency: { id: agencyRow.id, name: agencyRow.name, status: agencyRow.status as AgencyStatus },
    scope: trustedAgencyScope(orgScope, user.agencyId),
    db,
    now,
  }
}
