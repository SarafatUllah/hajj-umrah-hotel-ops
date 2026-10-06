import type { Database } from '../../db/client'
import { DEMO_ORG_SLUG } from '../../server/demo/catalog'
import { DEMO_PASSWORD, DEMO_PERSONAS } from '../../server/demo/personas'
import { type AuthContext, resolveAuthContext } from '../../server/security/authContext'
import { authenticate } from '../../server/services/auth.service'

/** Noon UTC on the default demo anchor date (2026-09-01): services that read "today" then see the anchor. */
export const DEMO_NOW = () => new Date(Date.UTC(2026, 8, 1, 12, 0, 0))

/** Logs a persona in through the REAL login service (DEMO_PASSWORD) and resolves its fresh auth context, like a request would. */
export async function demoContext(db: Database, personaKey: string, now: () => Date = DEMO_NOW): Promise<AuthContext> {
  const persona = DEMO_PERSONAS.find(p => p.key === personaKey)
  if (!persona) throw new Error(`Unknown demo persona ${personaKey}`)
  const auth = await authenticate(DEMO_ORG_SLUG, persona.email, DEMO_PASSWORD)
  if (!auth) throw new Error(`Persona ${personaKey} could not authenticate`)
  const ctx = await resolveAuthContext(db, { userId: auth.user.id, organizationId: auth.user.organizationId }, now)
  if (!ctx) throw new Error(`Persona ${personaKey} has no auth context`)
  return ctx
}
