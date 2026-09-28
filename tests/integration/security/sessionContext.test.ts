import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { userRole } from '../../../db/schema'
import type { Database } from '../../../db/client'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { getSessionContext } from '../../../server/services/sessionContextService'
import { seedDemoOrganization, DEMO_ADMIN_EMAIL } from '../../../db/seed/demo-org'
import { tenantRepos } from '../../../server/repositories'
import { makeOrg, makeRole, makeUser, makeUserWithPermissions } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

function ctxFor(scope: OrganizationScope, userId: string): AuthContext {
  return {
    identity: { userId, organizationId: scope.organizationId, email: 'irrelevant@test.com', fullName: 'Irrelevant' },
    authz: { permissions: new Set(), allHotels: false, hotelIds: new Set() },
    scope,
    db: db as Database,
    now: () => new Date(),
  }
}

describe('getSessionContext', () => {
  it('returns the caller\'s own organization and role keys/names', async () => {
    const { organization, scope: org } = await makeOrg(db, { name: 'Real Tenant' })
    const { user, role: roleRow } = await makeUserWithPermissions(db, org, ['booking.view'])

    const result = await getSessionContext(ctxFor(org, user.id))

    expect(result.organization).toEqual({ id: organization.id, name: organization.name, slug: organization.slug, isDemo: false })
    expect(result.roles).toEqual([{ key: roleRow.key, name: roleRow.name }])
  })

  it('isDemo is true only for the actual demo organization', async () => {
    const { organizationId, scope } = await seedDemoOrganization(db)
    const admin = await tenantRepos(db, scope).users.findByEmail(DEMO_ADMIN_EMAIL)

    const result = await getSessionContext(ctxFor(scope, admin!.id))

    expect(result.organization.id).toBe(organizationId)
    expect(result.organization.isDemo).toBe(true)
  })

  it('a user with multiple roles gets all of them', async () => {
    const { scope: org } = await makeOrg(db)
    const user = await makeUser(db, org)
    const roleA = await makeRole(db, org, { key: 'ROLE_A', name: 'Role A' })
    const roleB = await makeRole(db, org, { key: 'ROLE_B', name: 'Role B' })
    await tenantRepos(db, org).roles.assignToUser(user.id, roleA.id)
    await tenantRepos(db, org).roles.assignToUser(user.id, roleB.id)

    const result = await getSessionContext(ctxFor(org, user.id))

    expect(result.roles.map(r => r.key).sort()).toEqual(['ROLE_A', 'ROLE_B'])
  })

  it('never exposes a role from another organization, even when a cross-org user_role row is forced in', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const userA = await makeUser(db, orgA)
    const roleB = await makeRole(db, orgB, { key: 'FOREIGN_ROLE', name: 'Foreign Role' })

    // Same forced-insert technique as the Phase 0 regression test: composite FKs on user_role
    // reject a cross-org link, so it is planted with FK triggers disabled for this transaction only.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.insert(userRole).values({ organizationId: orgA.organizationId, userId: userA.id, roleId: roleB.id })
    })

    try {
      const planted = await db.select().from(userRole).where(and(eq(userRole.userId, userA.id), eq(userRole.roleId, roleB.id)))
      expect(planted.length).toBe(1)

      const result = await getSessionContext(ctxFor(orgA, userA.id))

      expect(result.roles).toEqual([])
    }
    finally {
      await db.delete(userRole).where(and(eq(userRole.userId, userA.id), eq(userRole.roleId, roleB.id)))
    }
  })
})
