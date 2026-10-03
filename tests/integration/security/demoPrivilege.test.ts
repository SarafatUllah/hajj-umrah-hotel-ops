import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { seedDemoOrganization } from '../../../db/seed/demo-org'
import { DEMO_ADMIN_EMAIL } from '../../../server/demo/personas'
import { seedOrganizationRoles, seedPermissionCatalog } from '../../../db/seed/rbac'
import { resolveAuthContext } from '../../../server/security/authContext'
import { resetDemoData, DemoOrganizationNotFoundError, DemoResetForbiddenError } from '../../../server/services/demo.service'
import { tenantRepos } from '../../../server/repositories'
import { makeOrg, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('demo-only organization.resetDemo (least privilege, PF-2)', () => {
  it('a fresh, non-demo organization\'s SUPER_ADMIN lacks organization.resetDemo', async () => {
    const { scope: org } = await makeOrg(db)
    await seedPermissionCatalog(db)
    const roleIdByKey = await seedOrganizationRoles(db, org.organizationId)
    const user = await makeUser(db, org)
    await tenantRepos(db, org).roles.assignToUser(user.id, roleIdByKey.SUPER_ADMIN!)

    const ctx = await resolveAuthContext(db, { userId: user.id, organizationId: org.organizationId })

    expect(ctx?.authz.permissions.has('organization.resetDemo')).toBe(false)
  })

  it('the demo organization\'s SUPER_ADMIN has organization.resetDemo', async () => {
    const { organizationId, scope } = await seedDemoOrganization(db)
    const admin = await tenantRepos(db, scope).users.findByEmail(DEMO_ADMIN_EMAIL)

    const ctx = await resolveAuthContext(db, { userId: admin!.id, organizationId })

    expect(ctx?.authz.permissions.has('organization.resetDemo')).toBe(true)
  })

  it('resetDemoData still works for a real demo-org member', async () => {
    const { organizationId, scope } = await seedDemoOrganization(db)
    const admin = await tenantRepos(db, scope).users.findByEmail(DEMO_ADMIN_EMAIL)

    const result = await resetDemoData({ userId: admin!.id, organizationId })

    expect(result.organizationId).toBeDefined()
  })

  it('resetDemoData still rejects a non-member even when the demo org does not yet exist', async () => {
    await expect(resetDemoData({ userId: '00000000-0000-0000-0000-000000000000', organizationId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toBeInstanceOf(DemoOrganizationNotFoundError)
  })

  it('resetDemoData still rejects a non-member of the demo org (second layer beyond the permission check)', async () => {
    await seedDemoOrganization(db)
    const { scope: otherOrg } = await makeOrg(db)
    const otherUser = await makeUser(db, otherOrg)

    await expect(resetDemoData({ userId: otherUser.id, organizationId: otherOrg.organizationId }))
      .rejects.toBeInstanceOf(DemoResetForbiddenError)
  })
})
