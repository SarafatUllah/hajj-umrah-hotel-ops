import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { permission, role, rolePermission } from '@hajj/db/schema'
import { ROLE_DEFINITIONS } from '@hajj/contracts/constants/roles'
import { syncRbacForAllOrganizations } from '../../../db/seed/rbac'
import { tenantRepos } from '../../../server/repositories'
import { makeOrg } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('syncRbacForAllOrganizations (deploy step)', () => {
  it('gives every organization\'s built-in roles their current permissions and 2FA flags, additively and idempotently', async () => {
    const first = await makeOrg(db)
    const second = await makeOrg(db)
    // An organization created before Phase 2: a Hotel Manager role with one old grant and a custom role.
    await db.insert(permission).values({ key: 'hotel.view', description: 'old' })
    const oldManager = await tenantRepos(db, first.scope).roles.insert({ key: 'HOTEL_MANAGER', name: 'Hotel Manager' })
    await tenantRepos(db, first.scope).roles.grantPermissions(oldManager.id, ['hotel.view'])
    const custom = await tenantRepos(db, first.scope).roles.insert({ key: 'NIGHT_DESK', name: 'Night desk' })
    await tenantRepos(db, first.scope).roles.grantPermissions(custom.id, ['hotel.view'])

    expect(await syncRbacForAllOrganizations(db)).toBe(2)
    expect(await syncRbacForAllOrganizations(db)).toBe(2)

    const managerGrants = (await db.select().from(rolePermission).where(eq(rolePermission.roleId, oldManager.id))).map(g => g.permissionKey).sort()
    expect(managerGrants).toEqual([...ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions].sort())
    expect(managerGrants).toContain('agency.manage')
    const [manager] = await db.select().from(role).where(eq(role.id, oldManager.id))
    expect(manager!.requiresTwoFactor).toBe(true)
    expect((await db.select().from(rolePermission).where(eq(rolePermission.roleId, custom.id))).map(g => g.permissionKey)).toEqual(['hotel.view'])
    expect(await tenantRepos(db, second.scope).roles.findByKey('RECEPTION')).not.toBeNull()
  })
})
