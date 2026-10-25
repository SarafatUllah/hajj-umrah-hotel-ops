import { accountsRepos } from '../../repositories'
import type { OrganizationScope } from '../../security/scope'

/** A booker: an agency or an individual customer. */
export interface BookerRef { agencyId: string | null, customerId: string | null }

/** For other modules (booking: the details reminder): the phone a booker is reached on by text message, or null. */
export async function findBookerPhone(db: Parameters<typeof accountsRepos>[0], scope: OrganizationScope, booker: BookerRef): Promise<string | null> {
  const repos = accountsRepos(db, scope)
  if (booker.agencyId) return (await repos.agencies.findById(booker.agencyId))?.phone ?? null
  if (booker.customerId) return (await repos.customers.findById(booker.customerId))?.phone ?? null
  return null
}
