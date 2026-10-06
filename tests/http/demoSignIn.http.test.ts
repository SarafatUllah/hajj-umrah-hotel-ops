import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { organization } from '../../db/schema'
import { demoIds } from '../../db/seed/demo/ids'
import { DEMO_HOTELS } from '../../server/demo/catalog'
import { DEMO_PASSWORD, DEMO_PERSONAS } from '../../server/demo/personas'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { closeTestDb, DEMO_ORG_SLUG, getHttpTestDb, makeOrg, seedDemoOrganization, truncateAllTables } from './support/fixtures'
import { expectServerToFailStartup, startExtraServer, type ExtraServer } from './support/spawnServer'

const db = getHttpTestDb()
/** The shared harness server: APP_ENV=development and DEMO_SIGN_IN_ENABLED unset (the default: off). */
const shared = apiClient(inject('httpTestBaseUrl'))

let demoServer: ExtraServer
let developmentServer: ExtraServer
let productionServer: ExtraServer
let stagingServer: ExtraServer
let stagingEnabledServer: ExtraServer
let demo: ReturnType<typeof apiClient>
let development: ReturnType<typeof apiClient>
let production: ReturnType<typeof apiClient>
let staging: ReturnType<typeof apiClient>
let stagingEnabled: ReturnType<typeof apiClient>

beforeAll(async () => {
  demoServer = await startExtraServer({ APP_ENV: 'demo', DEMO_SIGN_IN_ENABLED: 'true' })
  developmentServer = await startExtraServer({ APP_ENV: 'development', DEMO_SIGN_IN_ENABLED: 'true' })
  productionServer = await startExtraServer({ APP_ENV: 'production', DEMO_SIGN_IN_ENABLED: 'false' })
  stagingServer = await startExtraServer({ APP_ENV: 'staging', DEMO_SIGN_IN_ENABLED: 'false' })
  // Staging with the flag ON is a valid configuration: this server MUST start (startExtraServer rejects otherwise).
  stagingEnabledServer = await startExtraServer({ APP_ENV: 'staging', DEMO_SIGN_IN_ENABLED: 'true' })
  demo = apiClient(demoServer.baseUrl)
  development = apiClient(developmentServer.baseUrl)
  production = apiClient(productionServer.baseUrl)
  staging = apiClient(stagingServer.baseUrl)
  stagingEnabled = apiClient(stagingEnabledServer.baseUrl)
}, 120_000)

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await Promise.all([demoServer, developmentServer, productionServer, stagingServer, stagingEnabledServer].map(s => s?.stop()))
  await closeTestDb()
})

const URL_PATH = '/api/public/demo-sign-in'

describe('GET /api/public/demo-sign-in — disabled is indistinguishable from an unknown route', () => {
  it('flag off (the shared server): 404 with the same standard body as an unknown route, even with the demo organization present', async () => {
    await seedDemoOrganization(db)
    const res = await shared.request(URL_PATH)
    const unknown = await shared.request('/api/public/no-such-endpoint')
    expectStandardError(res, { status: 404, code: 'NOT_FOUND' })
    expect(res.status).toBe(unknown.status)
    // Identical body (shape and values) apart from the echoed request path the framework adds.
    const strip = (body: Record<string, unknown>) => { const { url: _url, ...rest } = body; return rest }
    expect(strip(res.json)).toEqual(strip(unknown.json))
    expect(Object.keys(res.json).sort()).toEqual(Object.keys(unknown.json).sort())
    expect(JSON.stringify(strip(res.json))).not.toMatch(/disabled|forbidden|demo/i)
    expect(JSON.stringify(strip(res.json))).toBe(JSON.stringify(strip(unknown.json)))
    expect(res.setCookie).toEqual([])
  })

  it('production with the flag false and staging with the flag false: 404, whatever is in the database', async () => {
    await seedDemoOrganization(db)
    for (const client of [production, staging]) {
      const res = await client.request(URL_PATH)
      expectStandardError(res, { status: 404, code: 'NOT_FOUND' })
      const unknown = await client.request('/api/public/other')
      expect(res.json.statusMessage).toBe(unknown.json.statusMessage)
      expect(res.json.data).toEqual(unknown.json.data)
    }
  })

  it('staging with the flag TRUE starts (valid configuration) and still answers exactly like an unknown route, with the demo organization present', async () => {
    await seedDemoOrganization(db)
    const res = await stagingEnabled.request(URL_PATH)
    const unknown = await stagingEnabled.request('/api/public/no-such-endpoint')
    expectStandardError(res, { status: 404, code: 'NOT_FOUND' })
    expect(res.status).toBe(unknown.status)
    const strip = (body: Record<string, unknown>) => { const { url: _url, ...rest } = body; return rest }
    expect(strip(res.json)).toEqual(strip(unknown.json))
    expect(Object.keys(res.json).sort()).toEqual(Object.keys(unknown.json).sort())
    expect(JSON.stringify(strip(res.json))).toBe(JSON.stringify(strip(unknown.json)))
    expect(JSON.stringify(res.json)).not.toContain(DEMO_PASSWORD)
    expect(JSON.stringify(strip(res.json))).not.toMatch(/disabled|forbidden|demo/i)
    expect(res.setCookie).toEqual([])
    // Only the env gate closes it: the very same database serves the payload on the demo server.
    expect((await demo.request(URL_PATH)).status).toBe(200)
  })

  it('only production refuses to START with DEMO_SIGN_IN_ENABLED=true (startup configuration error)', async () => {
    const result = await expectServerToFailStartup({ APP_ENV: 'production', DEMO_SIGN_IN_ENABLED: 'true' })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/DEMO_SIGN_IN_ENABLED=true is not allowed with APP_ENV=production/)
  }, 30_000)

  it('an invalid DEMO_ANCHOR_DATE also refuses to start (no silent default)', async () => {
    const result = await expectServerToFailStartup({ DEMO_ANCHOR_DATE: '2026-02-30' })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/DEMO_ANCHOR_DATE/)
  }, 30_000)
})

describe('GET /api/public/demo-sign-in — enabled (APP_ENV=demo or development, flag true)', () => {
  it.each([['demo'], ['development']] as const)('APP_ENV=%s: 200 without any cookie, the slug, password and nine personas, never a session', async (appEnv) => {
    await seedDemoOrganization(db)
    const client = appEnv === 'demo' ? demo : development
    const res = await client.request(URL_PATH)
    expect(res.status).toBe(200)
    expect(res.setCookie).toEqual([])
    // The credentials payload must never be cached by a browser or a proxy (raw fetch: the client helper exposes no headers).
    const raw = await fetch(`${(appEnv === 'demo' ? demoServer : developmentServer).baseUrl}${URL_PATH}`)
    expect(raw.status).toBe(200)
    expect(raw.headers.get('cache-control') ?? '').toMatch(/(^|,)\s*no-store\s*(,|$)/i)
    expect(raw.headers.getSetCookie()).toEqual([])
    await raw.body?.cancel()
    expect(Object.keys(res.json).sort()).toEqual(['organizationSlug', 'password', 'personas'])
    expect(res.json.organizationSlug).toBe(DEMO_ORG_SLUG)
    expect(res.json.password).toBe(DEMO_PASSWORD)
    expect(res.json.personas).toHaveLength(9)
    expect(res.json.personas.map((p: { email: string }) => p.email)).toEqual(DEMO_PERSONAS.map(p => p.email))
    expect(res.json.personas.find((p: { email: string }) => p.email === 'reservations@demo.alsafahotels.test')).toEqual({
      email: 'reservations@demo.alsafahotels.test', fullName: 'Aisha Rahman', roleName: 'Reservation Manager', phase1Available: true,
      hotels: ['MKK-GRAND', 'MKK-AJYAD', 'MKK-AZIZ'].map(code => ({ code, name: DEMO_HOTELS.find(h => h.code === code)!.name })),
    })
    const text = JSON.stringify(res.json)
    expect(text).not.toContain('argon2')
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it('every persona offered by the endpoint actually signs in over HTTP with the offered password', async () => {
    await seedDemoOrganization(db)
    const offer = (await demo.request(URL_PATH)).json
    for (const p of offer.personas) {
      const login = await demo.login(offer.organizationSlug, p.email, offer.password)
      expect(login.status, p.email).toBe(200)
      expect(login.json.user.fullName).toBe(p.fullName)
    }
  })

  it('404 (the unknown-route 404) when the demo organization does not exist', async () => {
    const res = await demo.request(URL_PATH)
    expectStandardError(res, { status: 404, code: 'NOT_FOUND' })
  })

  it('404 when the slug "demo" belongs to a non-demo organization', async () => {
    await makeOrg(db, { slug: DEMO_ORG_SLUG, isDemo: false })
    expectStandardError(await demo.request(URL_PATH), { status: 404, code: 'NOT_FOUND' })
  })

  it('serves again once the demo organization is flagged is_demo', async () => {
    await seedDemoOrganization(db)
    await db.update(organization).set({ isDemo: false }).where(eq(organization.id, demoIds.organization(DEMO_ORG_SLUG)))
    expect((await demo.request(URL_PATH)).status).toBe(404)
    await db.update(organization).set({ isDemo: true }).where(eq(organization.id, demoIds.organization(DEMO_ORG_SLUG)))
    expect((await demo.request(URL_PATH)).status).toBe(200)
  })

  it('only GET exists: POST is not a way in', async () => {
    await seedDemoOrganization(db)
    const res = await demo.request(URL_PATH, { method: 'POST', body: {} })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(res.json)).not.toContain(DEMO_PASSWORD)
  })
})
