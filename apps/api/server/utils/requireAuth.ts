import type { H3Event } from 'h3'
import { UnauthenticatedError } from '../errors/domainError'
import { resolveAuthContext, type AuthContext } from '../security/authContext'
import { useDb } from './db'
import { getEnv } from './env'

/**
 * Resolves the caller's identity from the session and hands back a fresh `AuthContext` — never a
 * permission/hotel-access snapshot from the session (that only ever carries `{ userId,
 * organizationId }`, plus display fields). Memoized on `event.context.authContext` for the lifetime
 * of the request: the (in-flight or resolved) promise is cached on the event, so two calls in the
 * same request-handling path resolve exactly once, whether sequential or concurrent.
 *
 * Staff routes only: a session of another principal kind (agency user, customer) is answered 401 without
 * being cleared — it stays valid for its own routes.
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
  const user = session.user!
  if ((user.kind ?? 'staff') !== 'staff') throw new UnauthenticatedError('UNAUTHENTICATED', 'Not signed in')

  const enforceTwoFactor = getEnv().STAFF_2FA_ENFORCEMENT === 'required-roles'
  const identity = { userId: user.id, organizationId: user.organizationId, sessionVersion: user.sessionVersion ?? 1 }
  const resolved = await resolveAuthContext(useDb(), identity, undefined, { enforceTwoFactor })
  if (!resolved) {
    await clearUserSession(event)
    throw new UnauthenticatedError('SESSION_INVALID')
  }
  return resolved
}

/**
 * After the caller's own 2FA change bumped their session version: keeps THIS session valid (every other
 * session of the user is now rejected by resolveAuthContext).
 */
export async function refreshSessionVersion(event: H3Event, sessionVersion: number): Promise<void> {
  const session = await requireUserSession(event)
  await setUserSession(event, { user: { ...session.user!, sessionVersion }, loggedInAt: session.loggedInAt })
}
