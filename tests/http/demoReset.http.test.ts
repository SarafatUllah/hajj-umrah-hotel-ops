import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { tenantRepos } from '../../server/repositories'
import { trustedOrganizationScope } from '../../server/security/scope'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import {
  closeTestDb,
  DEMO_ADMIN_EMAIL,
  DEMO_PASSWORD,
  DEMO_ORG_SLUG,
  getHttpTestDb,
  makeLoginableUser,
  makeOrg,
  makeRole,
  seedDemoOrganization,
  seedOrganizationRoles,
  seedPermissionCatalog,
  truncateAllTables,
} from './support/fixtures'

const client = apiClient(inject('httpTestBaseUrl'))
const db = getHttpTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('POST /api/admin/demo/reset — HTTP authorization (proof 8)', () => {
  it('another organization\'s Super Admin gets 403 (organization.resetDemo is demo-only)', async () => {
    const { organization, scope } = await makeOrg(db)
    await seedPermissionCatalog(db)
    const roleIdByKey = await seedOrganizationRoles(db, organization.id)
    const { user, password } = await makeLoginableUser(db, scope)
    await tenantRepos(db, scope).roles.assignToUser(user.id, roleIdByKey.SUPER_ADMIN!)

    const login = await client.login(organization.slug, user.email, password)
    expect(login.status).toBe(200)

    const res = await client.request('/api/admin/demo/reset', { method: 'POST', cookie: login.cookie })
    expectStandardError(res, { status: 403 })
  })

  it('a demo-org member without organization.resetDemo gets 403', async () => {
    const { organizationId, scope } = await seedDemoOrganization(db)
    const { user, password } = await makeLoginableUser(db, scope)
    const role = await makeRole(db, scope) // no permissions granted

    await tenantRepos(db, scope).roles.assignToUser(user.id, role.id)

    const login = await client.login(DEMO_ORG_SLUG, user.email, password)
    expect(login.status).toBe(200)
    expect(login.json.user.organizationId).toBe(organizationId)

    const res = await client.request('/api/admin/demo/reset', { method: 'POST', cookie: login.cookie })
    expectStandardError(res, { status: 403 })
  })

  it('the demo admin gets 200, and a real DEMO_RESET audit row exists afterward', async () => {
    await seedDemoOrganization(db)

    const login = await client.login(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_PASSWORD)
    expect(login.status).toBe(200)

    const res = await client.request('/api/admin/demo/reset', { method: 'POST', cookie: login.cookie })
    expect(res.status).toBe(200)
    expect(res.json.organizationId).toBeTruthy()

    const newScope = trustedOrganizationScope(res.json.organizationId)
    const page = await tenantRepos(db, newScope).audit.listOrganizationLevel({ action: 'DEMO_RESET', limit: 5 })
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.rows[0]!.action).toBe('DEMO_RESET')
  })
})
