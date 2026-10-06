import type { Database, DbOrTx } from '../client'
import { platformRepos } from '../../server/repositories'
import { trustedOrganizationScope, type OrganizationScope } from '../../server/security/scope'
import { seedPermissionCatalog, seedOrganizationRoles } from './rbac'
import { DEMO_PASSWORD } from '../../server/demo/personas'
import { DEMO_ORG_NAME, DEMO_ORG_SLUG, isValidDemoAnchorDate } from '../../server/demo/catalog'
import { getDemoEnv } from '../../server/utils/env'
import { hashPassword } from '../../server/utils/password'
import { DEMO_ONLY_PERMISSIONS } from '../../shared/constants/permissions'
import type { IsoDate } from '../../shared/utils/dates'
import { demoIds } from './demo/ids'
import { seedDemoDataset, type DemoSeedSummary } from './demo'

export { DEMO_ORG_SLUG }

/**
 * Thrown when the demo slug is already taken by an organization that is NOT
 * flagged `is_demo`. The seed must never adopt (and a later reset must never
 * wipe) someone else's real tenant just because it holds the slug.
 */
export class DemoSlugConflictError extends Error {
  constructor() {
    super(`Organization slug '${DEMO_ORG_SLUG}' is already used by a non-demo organization; refusing to seed demo data into it`)
    this.name = 'DemoSlugConflictError'
  }
}

/** Thrown when demo data would be written under APP_ENV=production without `ALLOW_DEMO_SEED=true`: no silent production seeding. */
export class DemoSeedForbiddenError extends Error {
  constructor() {
    super('Refusing to seed demo data with APP_ENV=production; set ALLOW_DEMO_SEED=true to override deliberately')
    this.name = 'DemoSeedForbiddenError'
  }
}

export interface SeedDemoOptions {
  /** The date every time-relative row hangs off; default `DEMO_ANCHOR_DATE` (env), else 2026-09-01. */
  anchorDate?: IsoDate
  /** Environment to read the demo settings from (default `process.env`); tests inject one. */
  env?: Record<string, string | undefined>
}

export interface SeedDemoResult {
  organizationId: string
  scope: OrganizationScope
  summary: DemoSeedSummary
}

/**
 * Validates the demo environment and refuses production seeding without the explicit override. Exported
 * so the reset service can fail BEFORE doing any work.
 */
export function assertDemoSeedAllowed(env: Record<string, string | undefined> = process.env): { anchorDate: IsoDate } {
  const demoEnv = getDemoEnv(env)
  if (demoEnv.APP_ENV === 'production' && !demoEnv.ALLOW_DEMO_SEED) throw new DemoSeedForbiddenError()
  return { anchorDate: demoEnv.DEMO_ANCHOR_DATE }
}

/**
 * Creates (or recreates) the complete, deterministic demo organization in ONE transaction: it is
 * atomic — any failure rolls everything back, leaving the previous state intact. Works on a plain
 * database handle or inside a caller's transaction (then it is a savepoint).
 *
 * An existing demo organization (`is_demo`) is replaced by one cascade delete and recreated under the
 * SAME ids (the baseline), so running it twice is idempotent and a reset never changes an id. A
 * non-demo organization holding the slug is refused. Every write goes through repositories scoped to
 * the demo organization (D7); the seed is a trusted scope minter. All nine personas share ONE password
 * hash, computed once per run.
 */
export async function seedDemoOrganization(db: DbOrTx, options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const { anchorDate: envAnchor } = assertDemoSeedAllowed(options.env)
  const anchorDate = options.anchorDate ?? envAnchor
  if (!isValidDemoAnchorDate(anchorDate)) throw new Error(`Invalid demo anchor date: ${anchorDate}`)

  // One Argon2 hash for all nine personas (computed outside the transaction: it is CPU work, not data).
  const passwordHash = await hashPassword(DEMO_PASSWORD)

  return (db as Database).transaction(async (tx) => {
    const organizations = platformRepos(tx).organizations
    await organizations.lockDemoSeed()
    await seedPermissionCatalog(tx)

    const existingOrg = await organizations.findBySlug(DEMO_ORG_SLUG)
    if (existingOrg && !existingOrg.isDemo) throw new DemoSlugConflictError()
    // One statement on the organization row cascades to the whole tenant graph and reaches no other organization.
    if (existingOrg) await organizations.deleteCascade(existingOrg.id)

    const org = await organizations.insert({ id: demoIds.organization(DEMO_ORG_SLUG), name: DEMO_ORG_NAME, slug: DEMO_ORG_SLUG, isDemo: true })

    // The demo organization's SUPER_ADMIN alone gets the demo-only permissions (organization.resetDemo)
    // — ROLE_DEFINITIONS.SUPER_ADMIN deliberately excludes them (least privilege, PF-2) so no other
    // organization's Super Admin can ever wipe another tenant's data.
    const roleIdByKey = await seedOrganizationRoles(tx, org.id, { extraPermissions: { SUPER_ADMIN: DEMO_ONLY_PERMISSIONS }, roleId: demoIds.role })

    // The scope below is confined to the freshly created organization: nothing here can touch another tenant.
    const scope = trustedOrganizationScope(org.id)
    const summary = await seedDemoDataset(tx, scope, { anchorDate, passwordHash, roleIdByKey })

    return { organizationId: org.id, scope, summary }
  })
}
