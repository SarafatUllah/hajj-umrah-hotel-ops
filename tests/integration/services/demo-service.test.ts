import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { organization, appUser, auditLog, userRole } from '../../../db/schema'
import { seedDemoOrganization, DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD } from '../../../db/seed/demo-org'
import { seedOrganizationRoles } from '../../../db/seed/rbac'
import { resetDemoData, DemoOrganizationNotFoundError, DemoResetForbiddenError } from '../../../server/services/demo.service'
import { useDb } from '../../../server/utils/db'
import { hashPassword } from '../../../server/utils/password'
import { authenticate } from '../../../server/services/auth.service'
import { closeTestDb, truncateAllTables } from '../support/testDb'

const db = useDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function seedDemoAndGetAdmin() {
  const { organizationId } = await seedDemoOrganization(db)
  const [admin] = await db
    .select()
    .from(appUser)
    .where(and(eq(appUser.organizationId, organizationId), eq(appUser.email, DEMO_ADMIN_EMAIL)))
    .limit(1)
  return { organizationId, actor: { userId: admin.id, organizationId } }
}

describe('resetDemoData', () => {
  it('throws when the demo organization does not exist yet', async () => {
    await expect(resetDemoData({
      userId: '00000000-0000-0000-0000-000000000000',
      organizationId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toBeInstanceOf(DemoOrganizationNotFoundError)
  })

  it('recreates the demo organization and admin login, and records an audit entry', async () => {
    const { actor } = await seedDemoAndGetAdmin()

    const result = await resetDemoData(actor)

    const authResult = await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD)
    expect(authResult).not.toBeNull()

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'DEMO_RESET'))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].organizationId).toBe(result.organizationId)
  })

  it('never touches a real, non-demo organization', async () => {
    const { actor } = await seedDemoAndGetAdmin()
    const [realOrg] = await db.insert(organization).values({ name: 'Real Customer Inc', slug: 'real-customer-2' }).returning()
    const [realUser] = await db.insert(appUser).values({
      organizationId: realOrg.id,
      email: 'owner@realcustomer.com',
      passwordHash: 'irrelevant-for-this-test',
      fullName: 'Real Owner',
    }).returning()

    await resetDemoData(actor)

    const [stillThere] = await db.select().from(appUser).where(eq(appUser.id, realUser.id)).limit(1)
    expect(stillThere).toBeDefined()
    expect(stillThere.email).toBe('owner@realcustomer.com')
  })

  it('refuses to delete a non-demo organization that occupies the demo slug', async () => {
    const [realOrg] = await db.insert(organization).values({ name: 'Real Tenant Named Demo', slug: DEMO_ORG_SLUG, isDemo: false }).returning()
    const [realUser] = await db.insert(appUser).values({
      organizationId: realOrg.id,
      email: 'owner@demo-named-tenant.com',
      passwordHash: 'irrelevant-for-this-test',
      fullName: 'Real Owner',
    }).returning()

    // Even a caller who belongs to that org gets "not found", not a wipe.
    await expect(resetDemoData({ userId: realUser.id, organizationId: realOrg.id }))
      .rejects.toBeInstanceOf(DemoOrganizationNotFoundError)

    const [orgStillThere] = await db.select().from(organization).where(eq(organization.id, realOrg.id)).limit(1)
    expect(orgStillThere).toBeDefined()
    const [userStillThere] = await db.select().from(appUser).where(eq(appUser.id, realUser.id)).limit(1)
    expect(userStillThere).toBeDefined()
  })

  it('rejects a Super Admin of a different organization and leaves the demo data untouched', async () => {
    const { organizationId: demoOrgId } = await seedDemoAndGetAdmin()

    // A fully legitimate Super Admin of an unrelated tenant: holds every
    // permission (including organization.resetDemo) within their own org.
    const [otherOrg] = await db.insert(organization).values({ name: 'Other Tenant', slug: 'other-tenant' }).returning()
    const otherRoles = await seedOrganizationRoles(db, otherOrg.id)
    const [otherAdmin] = await db.insert(appUser).values({
      organizationId: otherOrg.id,
      email: 'admin@other-tenant.com',
      passwordHash: await hashPassword('other-admin-password'),
      fullName: 'Other Super Admin',
    }).returning()
    await db.insert(userRole).values({ userId: otherAdmin.id, roleId: otherRoles.SUPER_ADMIN! })
    const otherLogin = await authenticate('other-tenant', 'admin@other-tenant.com', 'other-admin-password')
    expect(otherLogin?.permissions).toContain('organization.resetDemo')

    await expect(resetDemoData({ userId: otherAdmin.id, organizationId: otherOrg.id }))
      .rejects.toBeInstanceOf(DemoResetForbiddenError)

    // Same demo org row (not deleted and recreated), and no audit entry.
    const [demoOrg] = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG)).limit(1)
    expect(demoOrg.id).toBe(demoOrgId)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'DEMO_RESET'))).toEqual([])
  })

  it('rolls back the whole reset if any step fails, leaving the previous demo data intact', async () => {
    const { organizationId: demoOrgId, actor } = await seedDemoAndGetAdmin()

    // actor_user_id is a uuid column, so a non-uuid actor id makes the final
    // audit insert fail — after the delete and reseed have already run
    // inside the transaction.
    await expect(resetDemoData({ ...actor, userId: 'not-a-uuid' })).rejects.toThrow()

    const [demoOrg] = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG)).limit(1)
    expect(demoOrg.id).toBe(demoOrgId)
    const [admin] = await db.select().from(appUser).where(eq(appUser.id, actor.userId)).limit(1)
    expect(admin).toBeDefined()
  })

  it('handles two concurrent resets without a unique-constraint failure', async () => {
    const { actor } = await seedDemoAndGetAdmin()

    const results = await Promise.allSettled([resetDemoData(actor), resetDemoData(actor)])

    // Each reset either succeeds or — if it only starts after the other has
    // committed a fresh demo org — is rejected because the actor's org id is
    // now stale. Neither may fail with a database error.
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DemoResetForbiddenError)
    }
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    const demoOrgs = await db.select().from(organization).where(eq(organization.slug, DEMO_ORG_SLUG))
    expect(demoOrgs.length).toBe(1)
    expect(fulfilled.map(r => r.value.organizationId)).toContain(demoOrgs[0].id)
    expect(await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD)).not.toBeNull()
  })
})
