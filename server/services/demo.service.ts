import { eq, sql } from 'drizzle-orm'
import { useDb } from '../utils/db'
import { organization, auditLog } from '../../db/schema'
import { seedDemoOrganization, DEMO_ORG_SLUG } from '../../db/seed/demo-org'

export class DemoOrganizationNotFoundError extends Error {
  constructor() {
    super('Demo organization does not exist yet')
    this.name = 'DemoOrganizationNotFoundError'
  }
}

export async function resetDemoData(actorUserId: string): Promise<{ organizationId: string }> {
  const db = useDb()

  const [demoOrg] = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG)).limit(1)
  if (!demoOrg) throw new DemoOrganizationNotFoundError()

  // A single delete on the organization row cascades to every table that
  // references it (app_user, role, role_permission, user_role, audit_log)
  // and is scoped strictly to this one id — no other tenant's rows are
  // reachable by this statement.
  await db.execute(sql`DELETE FROM organization WHERE id = ${demoOrg.id}`)

  const { organizationId } = await seedDemoOrganization(db)

  await db.insert(auditLog).values({
    organizationId,
    actorUserId,
    entityType: 'organization',
    entityId: organizationId,
    action: 'DEMO_RESET',
    reason: 'Manual demo data reset',
  })

  return { organizationId }
}
