import { verifiedEmailOf } from '../../domain/accounts/customerRules'
import { accountsRepos } from '../../repositories'
import type { OrganizationScope } from '../../security/scope'

/** A booker: an agency or an individual customer. */
export interface BookerRef { agencyId: string | null, customerId: string | null }

/** Where a booker is reached: a phone (by text message) and/or a verified e-mail address. */
export interface BookerContact { phone: string | null, email: string | null }

/**
 * For other modules (booking: its messages to bookers): an agency's phone (its e-mail is contact data nobody proved),
 * or the phone and the verified e-mail a customer signs in with (D-P2-68). Nothing for a closed account or no booker.
 */
export async function findBookerContact(db: Parameters<typeof accountsRepos>[0], scope: OrganizationScope, booker: BookerRef): Promise<BookerContact> {
  const repos = accountsRepos(db, scope)
  if (booker.agencyId) return { phone: (await repos.agencies.findById(booker.agencyId))?.phone ?? null, email: null }
  const customerRow = booker.customerId ? await repos.customers.findById(booker.customerId) : null
  return { phone: customerRow?.phone ?? null, email: customerRow ? verifiedEmailOf(customerRow) : null }
}
