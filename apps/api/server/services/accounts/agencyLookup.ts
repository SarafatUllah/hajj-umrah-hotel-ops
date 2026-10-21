import type { AgencyStatus } from '@hajj/contracts/constants/accounts'
import { accountsRepos } from '../../repositories'
import type { OrganizationScope } from '../../security/scope'

export interface AgencyBrief { id: string, name: string, status: AgencyStatus }

/** For other modules (booking: quotes and bookings for an agency): the agency's name and status, or null. */
export async function findAgencyBrief(db: Parameters<typeof accountsRepos>[0], scope: OrganizationScope, agencyId: string): Promise<AgencyBrief | null> {
  const row = await accountsRepos(db, scope).agencies.findById(agencyId)
  return row ? { id: row.id, name: row.name, status: row.status as AgencyStatus } : null
}
