import type { DbOrTx } from '../client'
import { platformRepos, tenantRepos } from '../../server/repositories'
import { trustedOrganizationScope, type OrganizationScope } from '../../server/security/scope'
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

/**
 * Returns the demo organization's scope too: the seed is a trusted scope minter, so callers (the demo
 * reset) can write into the freshly seeded organization without minting a scope themselves.
 */
export async function seedDemoOrganization(db: DbOrTx): Promise<{ organizationId: string, scope: OrganizationScope }> {
  await seedPermissionCatalog(db)

  const organizations = platformRepos(db).organizations
  const existingOrg = await organizations.findBySlug(DEMO_ORG_SLUG)
  if (existingOrg && !existingOrg.isDemo) throw new DemoSlugConflictError()

  const org = existingOrg ?? await organizations.insert({
    name: 'Al Safa Hajj & Umrah Hotels (Demo)',
    slug: DEMO_ORG_SLUG,
    isDemo: true,
  })

  const roleIdByKey = await seedOrganizationRoles(db, org.id)

  // Every lookup and write below is confined to the demo organization's
  // scope. Email is unique only per organization, so an unscoped lookup
  // could adopt a same-email user from another tenant and link them to the
  // demo org's SUPER_ADMIN role.
  const scope = trustedOrganizationScope(org.id)
  const { users, roles } = tenantRepos(db, scope)
  const adminEmail = normalizeEmail(DEMO_ADMIN_EMAIL)

  const admin = await users.findByEmail(adminEmail) ?? await users.insert({
    email: adminEmail,
    passwordHash: await hashPassword(DEMO_ADMIN_PASSWORD),
    fullName: 'Demo Super Admin',
  })

  await roles.assignToUser(admin.id, roleIdByKey.SUPER_ADMIN!)

  return { organizationId: org.id, scope }
}
