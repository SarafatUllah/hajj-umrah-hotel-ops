import { eq } from 'drizzle-orm'
import type { Database } from '../client'
import { organization, appUser, userRole } from '../schema'
import { seedPermissionCatalog, seedOrganizationRoles } from './rbac'
import { hashPassword } from '../../server/utils/password'

export const DEMO_ORG_SLUG = 'demo'
export const DEMO_ADMIN_EMAIL = 'admin@demo.alsafahotels.test'
export const DEMO_ADMIN_PASSWORD = 'DemoPassword123!'

export async function seedDemoOrganization(db: Database): Promise<{ organizationId: string }> {
  await seedPermissionCatalog(db)

  const [existingOrg] = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG)).limit(1)

  const org = existingOrg
    ?? (await db.insert(organization).values({
      name: 'Al Safa Hajj & Umrah Hotels (Demo)',
      slug: DEMO_ORG_SLUG,
      isDemo: true,
    }).returning())[0]

  const roleIdByKey = await seedOrganizationRoles(db, org.id)

  const [existingAdmin] = await db.select().from(appUser).where(eq(appUser.email, DEMO_ADMIN_EMAIL)).limit(1)

  const admin = existingAdmin
    ?? (await db.insert(appUser).values({
      organizationId: org.id,
      email: DEMO_ADMIN_EMAIL,
      passwordHash: await hashPassword(DEMO_ADMIN_PASSWORD),
      fullName: 'Demo Super Admin',
    }).returning())[0]

  await db.insert(userRole).values({ userId: admin.id, roleId: roleIdByKey.SUPER_ADMIN }).onConflictDoNothing()

  return { organizationId: org.id }
}
