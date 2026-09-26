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

/**
 * Scope for an identity the server itself established (a verified session), never raw request input.
 * Importable only inside server/security (ESLint + layering fitness test): everything else receives a
 * scope from the auth context instead of minting one.
 */
export function scopeFromIdentity(identity: { organizationId: string }): OrganizationScope {
  return trustedOrganizationScope(identity.organizationId)
}
