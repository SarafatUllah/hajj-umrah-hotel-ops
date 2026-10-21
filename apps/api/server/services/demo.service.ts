import { useDb } from '../utils/db'
import { platformRepos, tenantRepos } from '../repositories'
import { seedDemoOrganization, assertDemoSeedAllowed, DEMO_ORG_SLUG, type SeedDemoResult } from '../../db/seed/demo-org'
import type { IsoDate } from '../../shared/utils/dates'

export { DemoSeedForbiddenError } from '../../db/seed/demo-org'

export class DemoOrganizationNotFoundError extends Error {
  constructor() {
    super('Demo organization does not exist yet')
    this.name = 'DemoOrganizationNotFoundError'
  }
}

/**
 * Thrown when the caller is not a member of the demo organization. The
 * `organization.resetDemo` permission alone is not enough: every
 * organization's SUPER_ADMIN holds the full permission catalog, so without
 * this check a Super Admin of an unrelated tenant could wipe the demo tenant.
 */
export class DemoResetForbiddenError extends Error {
  constructor() {
    super('Only members of the demo organization can reset demo data')
    this.name = 'DemoResetForbiddenError'
  }
}

export interface DemoResetActor {
  userId: string
  organizationId: string
}

export interface DemoResetOptions {
  /** The date every time-relative demo row hangs off (a real ISO date, validated by the caller); default `DEMO_ANCHOR_DATE`. */
  anchorDate?: IsoDate
}

export interface DemoResetResult {
  organizationId: string
  anchorDate: IsoDate
}

/**
 * Resets the demo organization to its deterministic baseline, atomically. The organization, its roles, the
 * nine users and every inventory entity are recreated under the SAME ids (so the caller's session stays
 * valid and a second reset is authorized again); only the demo organization is touched.
 */
export async function resetDemoData(actor: DemoResetActor, options: DemoResetOptions = {}): Promise<DemoResetResult> {
  // Production safety first (before any work): no silent production seeding.
  assertDemoSeedAllowed()
  const db = useDb()

  // One transaction for lookup + delete + reseed + audit (ARCHITECTURE §14): a failure anywhere rolls the
  // whole reset back, leaving the previous demo data intact rather than a half-deleted tenant.
  return db.transaction(async (tx) => {
    const organizations = platformRepos(tx).organizations
    // Serializes concurrent resets (and seeds): the next one starts after this commit and finds the recreated
    // organization under the same id, so a legitimate actor stays authorized.
    await organizations.lockDemoSeed()
    const demoOrg = await organizations.findBySlug(DEMO_ORG_SLUG)

    // An organization holding the demo slug but not flagged is_demo is a
    // real tenant — report it exactly like "no demo org" so callers can't
    // tell the difference, and never delete it.
    if (!demoOrg || !demoOrg.isDemo) throw new DemoOrganizationNotFoundError()

    if (actor.organizationId !== demoOrg.id) throw new DemoResetForbiddenError()

    // The seed (a trusted scope minter) deletes the demo organization in one cascading statement —
    // scoped strictly to that one id, so no other tenant's rows are reachable — recreates the deterministic
    // dataset, and hands back the new scope, so this service never mints one itself.
    const seeded: SeedDemoResult = await seedDemoOrganization(tx, { anchorDate: options.anchorDate })

    await tenantRepos(tx, seeded.scope).audit.record({
      actorUserId: actor.userId,
      entityType: 'organization',
      entityId: seeded.organizationId,
      action: 'DEMO_RESET',
      reason: 'Manual demo data reset',
    })

    return { organizationId: seeded.organizationId, anchorDate: seeded.summary.anchorDate }
  })
}
