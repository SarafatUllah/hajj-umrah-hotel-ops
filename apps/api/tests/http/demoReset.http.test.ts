import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { demoIds } from '../../db/seed/demo/ids'
import { DEMO_PERSONAS } from '../../server/demo/personas'
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

describe('demo reset and personas over HTTP (Task 20)', () => {
  it('two consecutive resets with the SAME cookie both return 200 (ids are stable, the session survives), keeping the same organization id', async () => {
    const { organizationId } = await seedDemoOrganization(db)
    const login = await client.login(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_PASSWORD)
    const first = await client.request('/api/admin/demo/reset', { method: 'POST', cookie: login.cookie })
    const second = await client.request('/api/admin/demo/reset', { method: 'POST', cookie: login.cookie })
    expect([first.status, second.status]).toEqual([200, 200])
    expect(first.json.organizationId).toBe(organizationId)
    expect(second.json.organizationId).toBe(organizationId)
    const me = await client.request('/api/auth/me', { cookie: login.cookie })
    expect(me.status).toBe(200)
    expect(me.json.user.userId).toBe(demoIds.user('admin'))
    expect(me.json.user.fullName).toBe('Faisal Al-Otaibi')
  })

  it('an optional strict body: a real anchorDate is accepted; a calendar-invalid date, a wrong type and unknown fields are 422', async () => {
    await seedDemoOrganization(db)
    const login = await client.login(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_PASSWORD)
    const post = (body: unknown) => client.request('/api/admin/demo/reset', { method: 'POST', cookie: login.cookie, body })
    const ok = await post({ anchorDate: '2026-11-15' })
    expect(ok.status).toBe(200)
    expect(ok.json.anchorDate).toBe('2026-11-15')
    expectStandardError(await post({ anchorDate: '2026-02-30' }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await post({ anchorDate: '1950-06-01' }), { status: 422, code: 'VALIDATION_FAILED' }) // real date, outside the supported demo window
    expectStandardError(await post({ anchorDate: 20260901 }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await post({ anchorDate: '2026-09-01T00:00:00Z' }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await post({ anchorDate: '2026-09-01', organizationId: 'x' }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await post({ isDemo: true }), { status: 422, code: 'VALIDATION_FAILED' })
    const back = await post({})
    expect(back.status).toBe(200)
    expect(back.json.anchorDate).toBe('2026-09-01')
  })

  it('every one of the nine personas logs in over HTTP and /api/auth/me returns the display name', async () => {
    await seedDemoOrganization(db)
    for (const p of DEMO_PERSONAS) {
      const login = await client.login(DEMO_ORG_SLUG, p.email, DEMO_PASSWORD)
      expect(login.status, p.key).toBe(200)
      const me = await client.request('/api/auth/me', { cookie: login.cookie })
      expect(me.json.user.fullName, p.key).toBe(p.fullName)
      expect(me.json.user.userId).toBe(demoIds.user(p.key))
    }
  })

  it('reservations lists exactly three hotels and gets 404 on MED-CENT; reception.grand is also 404 elsewhere; only the admin may reset', async () => {
    await seedDemoOrganization(db)
    const reservations = await client.login(DEMO_ORG_SLUG, 'reservations@demo.alsafahotels.test', DEMO_PASSWORD)
    const list = await client.request('/api/hotels', { cookie: reservations.cookie })
    expect(list.status).toBe(200)
    expect(list.json.map((h: { code: string }) => h.code).sort()).toEqual(['MKK-AJYAD', 'MKK-AZIZ', 'MKK-GRAND'])
    expectStandardError(await client.request(`/api/hotels/${demoIds.hotel('MED-CENT')}`, { cookie: reservations.cookie }), { status: 404, code: 'HOTEL_NOT_FOUND' })
    expect((await client.request(`/api/hotels/${demoIds.hotel('MKK-GRAND')}`, { cookie: reservations.cookie })).status).toBe(200)

    const reception = await client.login(DEMO_ORG_SLUG, 'reception.grand@demo.alsafahotels.test', DEMO_PASSWORD)
    expectStandardError(await client.request(`/api/hotels/${demoIds.hotel('MKK-AJYAD')}`, { cookie: reception.cookie }), { status: 404, code: 'HOTEL_NOT_FOUND' })

    // Every persona other than the admin lacks organization.resetDemo.
    for (const key of ['manager.grand', 'reservations', 'management']) {
      const p = DEMO_PERSONAS.find(x => x.key === key)!
      const login = await client.login(DEMO_ORG_SLUG, p.email, DEMO_PASSWORD)
      expectStandardError(await client.request('/api/admin/demo/reset', { method: 'POST', cookie: login.cookie }), { status: 403 })
    }
  })
})
