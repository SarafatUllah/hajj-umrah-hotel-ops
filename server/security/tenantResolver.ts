import type { DbOrTx } from '../../db/client'
import { platformRepos, type OrganizationRow } from '../repositories'
import { trustedOrganizationScope, type OrganizationScope } from './scope'

/**
 * Establishes a tenant from a public organization slug (login). Together with scopeFromIdentity
 * this is the only production code, besides the seeds, that mints an OrganizationScope.
 */
export async function resolveTenantBySlug(db: DbOrTx, slug: string): Promise<{ organization: OrganizationRow, scope: OrganizationScope } | null> {
  const organization = await platformRepos(db).organizations.findBySlug(slug)
  return organization ? { organization, scope: trustedOrganizationScope(organization.id) } : null
}

/** Scope for an identity the server itself established (a verified session or a server-side lookup), never raw request input. */
export function scopeFromIdentity(identity: { organizationId: string }): OrganizationScope {
  return trustedOrganizationScope(identity.organizationId)
}
