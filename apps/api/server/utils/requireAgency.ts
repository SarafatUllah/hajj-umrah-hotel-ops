import type { H3Event } from 'h3'
import { ForbiddenError, UnauthenticatedError } from '../errors/domainError'
import { resolveAgencyContext, type AgencyContext } from '../security/agencyContext'
import { useDb } from './db'

/**
 * The agency-portal counterpart of `requireAuthContext`: only an `agency` session passes (a staff or customer
 * session gets 401 and is left alone), resolved fresh and memoized per request.
 */
export async function requireAgencyContext(event: H3Event): Promise<AgencyContext> {
  const cached = event.context.agencyContext as Promise<AgencyContext> | undefined
  if (cached) return cached
  const promise = resolveForEvent(event)
  event.context.agencyContext = promise
  return promise
}

async function resolveForEvent(event: H3Event): Promise<AgencyContext> {
  const session = await requireUserSession(event)
  const user = session.user!
  if (user.kind !== 'agency' || !user.agencyId) throw new UnauthenticatedError('UNAUTHENTICATED', 'Not signed in')
  const resolved = await resolveAgencyContext(useDb(), { agencyUserId: user.id, organizationId: user.organizationId, agencyId: user.agencyId, sessionVersion: user.sessionVersion ?? 1 })
  if (!resolved) {
    await clearUserSession(event)
    throw new UnauthenticatedError('SESSION_INVALID')
  }
  return resolved
}

/** Agency prices, quotes and bookings are for APPROVED agencies only (v7 §15); `defineApiHandler({ auth: 'agency' })` applies it. */
export function requireApprovedAgency(ctx: AgencyContext): void {
  if (ctx.agency.status !== 'APPROVED') throw new ForbiddenError('AGENCY_NOT_APPROVED', 'Your agency is not approved yet')
}
