import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { organization, appUser, role, permission, rolePermission, userRole } from '../../../db/schema'
import { seedDemoOrganization, DemoSlugConflictError, DEMO_ORG_SLUG } from '../../../db/seed/demo-org'
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from '../../../server/demo/personas'
import { hashPassword } from '../../../server/utils/password'
import { authenticate } from '../../../server/services/auth.service'
import { resolveAuthContext } from '../../../server/security/authContext'
import { PERMISSIONS } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('seedDemoOrganization', () => {
  it('creates the demo organization, every permission, every role, and a working admin login', async () => {
    await seedDemoOrganization(db)

    const [org] = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG)).limit(1)
    expect(org).toBeDefined()
    expect(org.isDemo).toBe(true)

    const permissionRows = await db.select().from(permission)
    expect(permissionRows.length).toBe(PERMISSIONS.length)

    const roleRows = await db.select().from(role).where(eq(role.organizationId, org.id))
    expect(roleRows.length).toBe(Object.keys(ROLE_DEFINITIONS).length)

    const authResult = await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_PASSWORD)
    expect(authResult).not.toBeNull()

    // PF-1: authenticate() no longer carries a permission snapshot — re-assert via resolveAuthContext.
    const ctx = await resolveAuthContext(db, { userId: authResult!.user.id, organizationId: authResult!.user.organizationId })
    expect([...ctx!.authz.permissions].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('is idempotent: running it twice does not create duplicate rows', async () => {
    await seedDemoOrganization(db)
    await seedDemoOrganization(db)

    const orgRows = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG))
    expect(orgRows.length).toBe(1)

    const userRows = await db.select().from(appUser).where(eq(appUser.email, DEMO_ADMIN_EMAIL))
    expect(userRows.length).toBe(1)

    const permissionRows = await db.select().from(permission)
    expect(permissionRows.length).toBe(PERMISSIONS.length)
  })

  it('does not affect a pre-existing, unrelated organization', async () => {
    const [otherOrg] = await db.insert(organization).values({ name: 'Real Customer Inc', slug: 'real-customer' }).returning()

    await seedDemoOrganization(db)

    const [stillThere] = await db.select().from(organization).where(eq(organization.id, otherOrg.id)).limit(1)
    expect(stillThere).toBeDefined()
    expect(stillThere.slug).toBe('real-customer')
  })

  it('never adopts a same-email user from another organization as the demo admin', async () => {
    // A foreign tenant with its own user at exactly DEMO_ADMIN_EMAIL, holding
    // only a narrow role of its own.
    const [foreignOrg] = await db.insert(organization).values({ name: 'Foreign Org', slug: 'foreign-org' }).returning()
    const [foreignRole] = await db.insert(role).values({ organizationId: foreignOrg.id, key: 'VIEWER', name: 'Viewer' }).returning()
    await db.insert(permission).values({ key: 'booking.view', description: 'View bookings' }).onConflictDoNothing()
    await db.insert(rolePermission).values({ roleId: foreignRole.id, permissionKey: 'booking.view' })
    const [foreignUser] = await db.insert(appUser).values({
      organizationId: foreignOrg.id,
      email: DEMO_ADMIN_EMAIL,
      passwordHash: await hashPassword('foreign-org-password'),
      fullName: 'Foreign User',
    }).returning()
    await db.insert(userRole).values({ organizationId: foreignOrg.id, userId: foreignUser.id, roleId: foreignRole.id })

    const { organizationId: demoOrgId } = await seedDemoOrganization(db)

    // (a) The foreign user holds no role in the demo organization.
    const foreignUserRoles = await db
      .select({ organizationId: role.organizationId, key: role.key })
      .from(userRole)
      .innerJoin(role, eq(role.id, userRole.roleId))
      .where(eq(userRole.userId, foreignUser.id))
    expect(foreignUserRoles).toEqual([{ organizationId: foreignOrg.id, key: 'VIEWER' }])

    // The demo org got its own, separate admin user (alongside the eight other personas).
    expect((await db.select().from(appUser).where(eq(appUser.organizationId, demoOrgId))).length).toBe(9)
    const demoAdmins = await db.select().from(appUser).where(and(eq(appUser.organizationId, demoOrgId), eq(appUser.email, DEMO_ADMIN_EMAIL)))
    expect(demoAdmins.length).toBe(1)
    expect(demoAdmins[0].id).not.toBe(foreignUser.id)

    // (b) Logging into the foreign org yields only the foreign org's grants.
    const foreignLogin = await authenticate('foreign-org', DEMO_ADMIN_EMAIL, 'foreign-org-password')
    expect(foreignLogin?.user.organizationId).toBe(foreignOrg.id)
    const foreignCtx = await resolveAuthContext(db, { userId: foreignLogin!.user.id, organizationId: foreignLogin!.user.organizationId })
    expect([...foreignCtx!.authz.permissions]).toEqual(['booking.view'])

    // And the demo admin login still works with the demo password.
    const demoLogin = await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_PASSWORD)
    expect(demoLogin?.user.organizationId).toBe(demoOrgId)
    const demoCtx = await resolveAuthContext(db, { userId: demoLogin!.user.id, organizationId: demoLogin!.user.organizationId })
    expect([...demoCtx!.authz.permissions].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('refuses to adopt a non-demo organization that occupies the demo slug', async () => {
    const [realOrg] = await db.insert(organization).values({ name: 'Real Tenant Named Demo', slug: DEMO_ORG_SLUG, isDemo: false }).returning()

    await expect(seedDemoOrganization(db)).rejects.toBeInstanceOf(DemoSlugConflictError)

    // The real org was left exactly as it was: not flagged, no roles, no users.
    const [stillThere] = await db.select().from(organization).where(eq(organization.id, realOrg.id)).limit(1)
    expect(stillThere.isDemo).toBe(false)
    expect(await db.select().from(role).where(eq(role.organizationId, realOrg.id))).toEqual([])
    expect(await db.select().from(appUser).where(eq(appUser.organizationId, realOrg.id))).toEqual([])
  })
})
