import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../../../db/schema'
import { organization } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { seedDemoOrganization } from '../../../db/seed/demo-org'
import { demoIds } from '../../../db/seed/demo/ids'
import { DEMO_HOTELS, DEMO_ORG_SLUG } from '../../../server/demo/catalog'
import { DEMO_PASSWORD, DEMO_PERSONAS } from '../../../server/demo/personas'
import { getDemoSignIn } from '../../../server/services/demoSignInService'
import { getDemoEnv, getEnv, resetEnvCache } from '../../../server/utils/env'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { makeOrg, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

beforeEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await truncateAllTables()
  await closeTestDb()
})

const env = (appEnv: string, flag?: string) => ({ APP_ENV: appEnv, ...(flag === undefined ? {} : { DEMO_SIGN_IN_ENABLED: flag }) })

/** What the endpoint must return, derived only from the static catalogue, independently of the service code. */
function expectedPayload() {
  const names = Object.fromEntries(DEMO_HOTELS.map(h => [h.code, h.name]))
  return {
    organizationSlug: 'demo',
    password: DEMO_PASSWORD,
    personas: DEMO_PERSONAS.map(p => ({
      email: p.email,
      fullName: p.fullName,
      roleName: ROLE_DEFINITIONS[p.roleKey]!.name,
      hotels: (p.hotelCodes === 'all' ? DEMO_HOTELS.map(h => h.code) : [...p.hotelCodes]).map(code => ({ code, name: names[code]! })),
      phase1Available: p.phase1Available,
    })),
  }
}

describe('getDemoSignIn: the environment gate', () => {
  it.each([
    ['development', 'true'],
    ['demo', 'true'],
  ])('APP_ENV=%s DEMO_SIGN_IN_ENABLED=%s with the demo organization present -> the payload', async (appEnv, flag) => {
    await seedDemoOrganization(db)
    expect(await getDemoSignIn(db, env(appEnv, flag))).toEqual(expectedPayload())
  })

  it.each([
    ['development', 'false'],
    ['development', undefined],
    ['demo', 'false'],
    ['demo', undefined],
    ['production', 'false'],
    ['production', undefined],
    ['staging', 'false'],
    // never open, whatever the flag says (staging + true is a valid configuration, but still closed)
    ['production', 'true'],
    ['staging', 'true'],
    ['development', 'TRUE'],
    ['development', '1'],
  ])('APP_ENV=%s DEMO_SIGN_IN_ENABLED=%s -> not served (null: the route turns it into the unknown-route 404)', async (appEnv, flag) => {
    await seedDemoOrganization(db)
    expect(await getDemoSignIn(db, env(appEnv, flag))).toBeNull()
  })

  it('production + true is also a startup configuration error (defense in depth, layer 1)', () => {
    expect(() => getDemoEnv(env('production', 'true'))).toThrow(/DEMO_SIGN_IN_ENABLED=true is not allowed with APP_ENV=production/)
    const saved = { ...process.env }
    try {
      Object.assign(process.env, { APP_ENV: 'production', DEMO_SIGN_IN_ENABLED: 'true' })
      resetEnvCache()
      expect(() => getEnv()).toThrow(/DEMO_SIGN_IN_ENABLED/)
    }
    finally {
      process.env = saved
      resetEnvCache()
    }
  })

  it('staging + true is NOT a startup error (valid configuration), yet the service still returns null', async () => {
    expect(getDemoEnv(env('staging', 'true'))).toMatchObject({ APP_ENV: 'staging', DEMO_SIGN_IN_ENABLED: true })
    await seedDemoOrganization(db)
    expect(await getDemoSignIn(db, env('staging', 'true'))).toBeNull()
  })

  it('the default source is the real process environment: with it unset the endpoint is off', async () => {
    await seedDemoOrganization(db)
    const saved = { ...process.env }
    try {
      delete process.env.DEMO_SIGN_IN_ENABLED
      expect(await getDemoSignIn(db)).toBeNull()
    }
    finally {
      process.env = saved
    }
  })
})

describe('getDemoSignIn: the demo organization check', () => {
  it('is null when no organization exists at all', async () => {
    expect(await getDemoSignIn(db, env('development', 'true'))).toBeNull()
  })

  it('is null when only another organization exists', async () => {
    await makeOrg(db, { slug: 'not-demo' })
    expect(await getDemoSignIn(db, env('development', 'true'))).toBeNull()
  })

  it('is null when the slug "demo" belongs to a non-demo organization (is_demo = false)', async () => {
    await makeOrg(db, { slug: DEMO_ORG_SLUG, isDemo: false })
    expect(await getDemoSignIn(db, env('development', 'true'))).toBeNull()
  })

  it('is served once the demo organization (is_demo) exists, and stops when it is flagged off', async () => {
    await seedDemoOrganization(db)
    expect(await getDemoSignIn(db, env('demo', 'true'))).not.toBeNull()
    await db.update(organization).set({ isDemo: false }).where(eq(organization.id, demoIds.organization(DEMO_ORG_SLUG)))
    expect(await getDemoSignIn(db, env('demo', 'true'))).toBeNull()
  })
})

describe('getDemoSignIn: the response is safe and exactly the catalogue', () => {
  it('equals the catalogue-derived values exactly: slug, the documented password and nine personas', async () => {
    await seedDemoOrganization(db)
    const payload = await getDemoSignIn(db, env('development', 'true'))
    expect(payload).toEqual(expectedPayload())
    expect(payload!.personas).toHaveLength(9)
    expect(Object.keys(payload!).sort()).toEqual(['organizationSlug', 'password', 'personas'])
    for (const p of payload!.personas) expect(Object.keys(p).sort()).toEqual(['email', 'fullName', 'hotels', 'phase1Available', 'roleName'])
  })

  it('exposes no hash, no user/role/hotel/organization id, no permission and nothing of another organization', async () => {
    const other = await makeOrg(db, { slug: 'other-org' })
    const secretUser = await makeUser(db, other.scope, { email: 'secret.person@other.test', fullName: 'Secret Other Person' })
    const { organizationId } = await seedDemoOrganization(db)
    const text = JSON.stringify(await getDemoSignIn(db, env('development', 'true')))
    const [anyHash] = (await db.select().from(schema.appUser).where(eq(schema.appUser.organizationId, organizationId))).map(u => u.passwordHash)
    expect(text).not.toContain('argon2')
    expect(text).not.toContain(anyHash!)
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) // no uuid at all
    expect(text).not.toContain(organizationId)
    expect(text).not.toContain(other.organization.id)
    expect(text).not.toContain(secretUser.id)
    expect(text).not.toContain('Secret Other Person')
    expect(text).not.toMatch(/room\.|hotel\.manage|permission|roleKey|SUPER_ADMIN|organization\.resetDemo/)
  })

  it('does not depend on tenant data: it answers the same after the demo users are renamed or removed', async () => {
    const { organizationId } = await seedDemoOrganization(db)
    await db.update(schema.appUser).set({ fullName: 'Renamed' }).where(eq(schema.appUser.organizationId, organizationId))
    expect(await getDemoSignIn(db, env('development', 'true'))).toEqual(expectedPayload())
    await db.delete(schema.appUser).where(eq(schema.appUser.organizationId, organizationId))
    expect(await getDemoSignIn(db, env('development', 'true'))).toEqual(expectedPayload())
  })

  it('runs exactly ONE query, on the organization table only: no tenant table (users, roles, hotels, ...) is read', async () => {
    await seedDemoOrganization(db)
    const statements: string[] = []
    const spying = drizzle(getTestClient(), { schema, logger: { logQuery: (query: string) => { statements.push(query) } } }) as unknown as Database
    expect(await getDemoSignIn(spying, env('development', 'true'))).not.toBeNull()
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/from "organization"/)
    expect(statements[0]).not.toMatch(/app_user|"role"|hotel|room|user_role|audit/)
    // closed gate: no query at all
    statements.length = 0
    expect(await getDemoSignIn(spying, env('production', 'false'))).toBeNull()
    expect(statements).toHaveLength(0)
  })
})

describe('demo sign-in service source (static fitness)', () => {
  const source = readFileSync(join(import.meta.dirname, '../../../server/services/demoSignInService.ts'), 'utf8')
  it('mints no scope and uses no tenant repositories: only the platform organization lookup', () => {
    expect(source).not.toMatch(/trusted(Organization|Hotel)Scope/)
    expect(source).not.toMatch(/security\/scope|tenantResolver|authContext/)
    expect(source).not.toMatch(/tenantRepos|hotelRepos/)
    expect(source).toMatch(/platformRepos\(db\)\.organizations\.findBySlug\(DEMO_ORG_SLUG\)/)
    expect(source).not.toMatch(/passwordHash|password_hash|hashPassword/)
  })
})
