import type { DbOrTx } from '@hajj/db/client'
import { platformRepos } from '../repositories'
import { trustedOrganizationScope, type OrganizationScope } from './scope'

/** Every organization's scope, for background jobs that sweep all tenants (e.g. quote expiry). */
export async function allOrganizationScopes(db: DbOrTx): Promise<OrganizationScope[]> {
  return (await platformRepos(db).organizations.listIds()).map(trustedOrganizationScope)
}

/** The scope of one organization named by a background job's payload; null when it no longer exists. */
export async function organizationScopeById(db: DbOrTx, organizationId: string): Promise<OrganizationScope | null> {
  return (await platformRepos(db).organizations.findById(organizationId)) ? trustedOrganizationScope(organizationId) : null
}
