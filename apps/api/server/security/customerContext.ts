import type { Database } from '@hajj/db/client'
import { accountsRepos } from '../repositories'
import { verifiedEmailOf } from '../services/accounts'
import { trustedCustomerScope, trustedOrganizationScope, type CustomerScope } from './scope'

export interface CustomerIdentity {
  customerId: string
  organizationId: string
  /** The phone and the verified e-mail the customer signs in with: at least one (D-P2-68), never linked to another account. */
  phone: string | null
  email: string | null
  fullName: string
}

/** A signed-in customer (public site), resolved fresh on every request. */
export interface CustomerContext {
  identity: CustomerIdentity
  scope: CustomerScope
  db: Database
  now: () => Date
  /** When this session's code was verified (a step-up for sensitive actions asks for a recent one); null = unknown. */
  signedInAt: Date | null
}

/** `null` = no valid session: unknown, inactive or closed, or a session older than the customer's session version. */
export async function resolveCustomerContext(
  db: Database,
  identity: { customerId: string, organizationId: string, sessionVersion?: number, signedInAt?: Date },
  now: () => Date = () => new Date(),
): Promise<CustomerContext | null> {
  const orgScope = trustedOrganizationScope(identity.organizationId)
  const row = await accountsRepos(db, orgScope).customers.findById(identity.customerId)
  if (!row || !row.isActive || row.closedAt) return null
  if (identity.sessionVersion !== undefined && identity.sessionVersion !== row.sessionVersion) return null
  return {
    identity: { customerId: row.id, organizationId: row.organizationId, phone: row.phone, email: verifiedEmailOf(row), fullName: row.fullName },
    scope: trustedCustomerScope(orgScope, row.id),
    db,
    now,
    signedInAt: identity.signedInAt ?? null,
  }
}
