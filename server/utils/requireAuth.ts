import type { H3Event } from 'h3'
import { UnauthenticatedError } from '../errors/domainError'
import { resolveAuthContext, type AuthContext } from '../security/authContext'
import { useDb } from './db'

/**
 * Resolves the caller's identity from the session and hands back a fresh `AuthContext` — never a
 * permission/hotel-access snapshot from the session (that only ever carries `{ userId,
 * organizationId }`, plus display fields). Memoized on `event.context.authContext` for the lifetime
 * of the request: the (in-flight or resolved) promise is cached on the event, so two calls in the
 * same request-handling path resolve exactly once, whether sequential or concurrent.
 */
export async function requireAuthContext(event: H3Event): Promise<AuthContext> {
  const cached = event.context.authContext as Promise<AuthContext> | undefined
  if (cached) return cached

  const promise = resolveForEvent(event)
  event.context.authContext = promise
  return promise
}

async function resolveForEvent(event: H3Event): Promise<AuthContext> {
  const session = await requireUserSession(event)
  const resolved = await resolveAuthContext(useDb(), { userId: session.user!.id, organizationId: session.user!.organizationId })
  if (!resolved) {
    await clearUserSession(event)
    throw new UnauthenticatedError('SESSION_INVALID')
  }
  return resolved
}
