import { afterAll, afterEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import { createDb } from '../../../db/client'
import { organization, appUser, role, permission } from '../../../db/schema'
import { seedDemoOrganization, DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD } from '../../../db/seed/demo-org'
import { authenticate } from '../../../server/services/auth.service'
import { PERMISSIONS } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL must be set (run via `dotenv -e .env.test`)')

const client = postgres(connectionString, { max: 1 })
const rawDb = drizzle(client)
const db = createDb(connectionString)

afterEach(async () => {
  await rawDb.execute(sql`TRUNCATE TABLE user_role, role_permission, permission, role, app_user, organization RESTART IDENTITY CASCADE`)
})

afterAll(async () => {
  await client.end()
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

    const authResult = await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD)
    expect(authResult).not.toBeNull()
    expect(authResult?.permissions.slice().sort()).toEqual([...PERMISSIONS].sort())
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
})
