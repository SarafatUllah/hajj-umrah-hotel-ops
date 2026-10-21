import type { H3Event } from 'h3'
import { UnauthenticatedError } from '../errors/domainError'
import { resolveCustomerContext, type CustomerContext } from '../security/customerContext'
import { useDb } from './db'

/** The public-site counterpart of `requireAuthContext`: only a `customer` session passes, resolved fresh, memoized per request. */
export async function requireCustomerContext(event: H3Event): Promise<CustomerContext> {
  const cached = event.context.customerContext as Promise<CustomerContext> | undefined
  if (cached) return cached
  const promise = resolveForEvent(event)
  event.context.customerContext = promise
  return promise
}

async function resolveForEvent(event: H3Event): Promise<CustomerContext> {
  const session = await requireUserSession(event)
  const user = session.user!
  if (user.kind !== 'customer') throw new UnauthenticatedError('UNAUTHENTICATED', 'Not signed in')
  const resolved = await resolveCustomerContext(useDb(), { customerId: user.id, organizationId: user.organizationId, sessionVersion: user.sessionVersion ?? 1 })
  if (!resolved) {
    await clearUserSession(event)
    throw new UnauthenticatedError('SESSION_INVALID')
  }
  return resolved
}
