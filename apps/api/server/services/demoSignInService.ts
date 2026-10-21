import { DEMO_HOTELS, DEMO_ORG_SLUG } from '../demo/catalog'
import { DEMO_PASSWORD, DEMO_PERSONAS } from '../demo/personas'
import { platformRepos } from '../repositories'
import { isDemoSignInEnabled } from '../utils/env'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'

/** The database handle a platform repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof platformRepos>[0]

export interface DemoSignInPersona {
  email: string
  fullName: string
  roleName: string
  hotels: Array<{ code: string, name: string }>
  phase1Available: boolean
}

export interface DemoSignInPayload {
  organizationSlug: string
  password: string
  personas: DemoSignInPersona[]
}

/**
 * The public demo sign-in metadata (S14 / D9). Returns `null` — which the route turns into the SAME 404 an
 * unknown route gives — unless ALL of these hold:
 *   - the runtime gate is open (`DEMO_SIGN_IN_ENABLED=true` AND `APP_ENV` is development or demo;
 *     production and staging never), and
 *   - an organization with slug `demo` exists AND is flagged `is_demo`.
 *
 * It reads only the static catalogues plus ONE platform lookup (`PlatformOrganizationRepository.findBySlug`):
 * it mints no scope, runs no tenant query and loads no user or role from the tenant database, so it can
 * never expose a hash, an id or any tenant row. It authenticates nobody and mints no session.
 */
export async function getDemoSignIn(db: Db, env: Record<string, string | undefined> = process.env): Promise<DemoSignInPayload | null> {
  if (!isDemoSignInEnabled(env)) return null

  const org = await platformRepos(db).organizations.findBySlug(DEMO_ORG_SLUG)
  if (!org || !org.isDemo) return null

  const hotelsOf = (codes: 'all' | readonly string[]) =>
    DEMO_HOTELS.filter(h => codes === 'all' || codes.includes(h.code)).map(h => ({ code: h.code, name: h.name }))

  return {
    organizationSlug: DEMO_ORG_SLUG,
    password: DEMO_PASSWORD,
    personas: DEMO_PERSONAS.map(p => ({
      email: p.email,
      fullName: p.fullName,
      roleName: ROLE_DEFINITIONS[p.roleKey]!.name,
      hotels: hotelsOf(p.hotelCodes),
      phase1Available: p.phase1Available,
    })),
  }
}
