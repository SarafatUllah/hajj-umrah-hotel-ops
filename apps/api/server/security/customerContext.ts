import type { Database } from '@hajj/db/client'
import { accountsRepos } from '../repositories'
import { trustedCustomerScope, trustedOrganizationScope, type CustomerScope } from './scope'

export interface CustomerIdentity {
  customerId: string
  organizationId: string
  phone: string
  fullName: string
}

/** A signed-in customer (public site), resolved fresh on every request. */
export interface CustomerContext {
  identity: CustomerIdentity
  scope: CustomerScope
  db: Database
  now: () => Date
}

/** `null` = no valid session: unknown, inactive, or a session older than the customer's session version. */
export async function resolveCustomerContext(
  db: Database,
  identity: { customerId: string, organizationId: string, sessionVersion?: number },
  now: () => Date = () => new Date(),
): Promise<CustomerContext | null> {
  const orgScope = trustedOrganizationScope(identity.organizationId)
  const row = await accountsRepos(db, orgScope).customers.findById(identity.customerId)
  if (!row || !row.isActive) return null
  if (identity.sessionVersion !== undefined && identity.sessionVersion !== row.sessionVersion) return null
  return {
    identity: { customerId: row.id, organizationId: row.organizationId, phone: row.phone, fullName: row.fullName },
    scope: trustedCustomerScope(orgScope, row.id),
    db,
    now,
  }
}
