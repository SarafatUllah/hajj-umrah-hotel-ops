import { useDb } from '../utils/db'
import { platformRepos, tenantRepos } from '../repositories'
import { scopeFromIdentity } from '../security/tenantResolver'
import { seedDemoOrganization, DEMO_ORG_SLUG } from '../../db/seed/demo-org'

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

export async function resetDemoData(actor: DemoResetActor): Promise<{ organizationId: string }> {
  const db = useDb()

  // One transaction for lookup + delete + reseed + audit (ARCHITECTURE §14):
  // a failure anywhere rolls the whole reset back, leaving the previous demo
  // data intact rather than a half-deleted tenant.
  return db.transaction(async (tx) => {
    const organizations = platformRepos(tx).organizations
    const demoOrg = await organizations.findBySlug(DEMO_ORG_SLUG)

    // An organization holding the demo slug but not flagged is_demo is a
    // real tenant — report it exactly like "no demo org" so callers can't
    // tell the difference, and never delete it.
    if (!demoOrg || !demoOrg.isDemo) throw new DemoOrganizationNotFoundError()

    if (actor.organizationId !== demoOrg.id) throw new DemoResetForbiddenError()

    // A single delete on the organization row cascades to every table that
    // references it (app_user, role, role_permission, user_role, audit_log)
    // and is scoped strictly to this one id — no other tenant's rows are
    // reachable by this statement.
    await organizations.deleteCascade(demoOrg.id)

    const { organizationId } = await seedDemoOrganization(tx)

    // The organization id comes from the seed just run inside this
    // transaction, never from the request.
    await tenantRepos(tx, scopeFromIdentity({ organizationId })).audit.record({
      actorUserId: actor.userId,
      entityType: 'organization',
      entityId: organizationId,
      action: 'DEMO_RESET',
      reason: 'Manual demo data reset',
    })

    return { organizationId }
  })
}
