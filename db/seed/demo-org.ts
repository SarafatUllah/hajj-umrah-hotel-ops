import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../client'
import { organization, appUser, userRole } from '../schema'
import { seedPermissionCatalog, seedOrganizationRoles } from './rbac'
import { hashPassword } from '../../server/utils/password'
import { normalizeEmail } from '../../shared/utils/email'

export const DEMO_ORG_SLUG = 'demo'
export const DEMO_ADMIN_EMAIL = 'admin@demo.alsafahotels.test'
export const DEMO_ADMIN_PASSWORD = 'DemoPassword123!'

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

export async function seedDemoOrganization(db: DbOrTx): Promise<{ organizationId: string }> {
  await seedPermissionCatalog(db)

  const [existingOrg] = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG)).limit(1)
  if (existingOrg && !existingOrg.isDemo) throw new DemoSlugConflictError()

  const org = existingOrg
    ?? (await db.insert(organization).values({
      name: 'Al Safa Hajj & Umrah Hotels (Demo)',
      slug: DEMO_ORG_SLUG,
      isDemo: true,
    }).returning())[0]!

  const roleIdByKey = await seedOrganizationRoles(db, org.id)

  const adminEmail = normalizeEmail(DEMO_ADMIN_EMAIL)

  // Email is unique only per organization, so this lookup MUST be scoped to
  // the demo org — an email-only lookup could adopt a same-email user from
  // another tenant and link them to the demo org's SUPER_ADMIN role.
  const [existingAdmin] = await db
    .select()
    .from(appUser)
    .where(and(eq(appUser.organizationId, org.id), eq(appUser.email, adminEmail)))
    .limit(1)

  const admin = existingAdmin
    ?? (await db.insert(appUser).values({
      organizationId: org.id,
      email: adminEmail,
      passwordHash: await hashPassword(DEMO_ADMIN_PASSWORD),
      fullName: 'Demo Super Admin',
    }).returning())[0]!

  await db.insert(userRole).values({ userId: admin.id, roleId: roleIdByKey.SUPER_ADMIN! }).onConflictDoNothing()

  return { organizationId: org.id }
}
