import { afterAll, afterEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import { organization, appUser, auditLog } from '../../../db/schema'
import { seedDemoOrganization, DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD } from '../../../db/seed/demo-org'
import { resetDemoData, DemoOrganizationNotFoundError } from '../../../server/services/demo.service'
import { useDb } from '../../../server/utils/db'
import { authenticate } from '../../../server/services/auth.service'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL must be set (run via `dotenv -e .env.test`)')

const client = postgres(connectionString, { max: 1 })
const rawDb = drizzle(client)
const db = useDb()

afterEach(async () => {
  await rawDb.execute(sql`TRUNCATE TABLE audit_log, user_role, role_permission, permission, role, app_user, organization RESTART IDENTITY CASCADE`)
})

afterAll(async () => {
  await client.end()
})

describe('resetDemoData', () => {
  it('throws when the demo organization does not exist yet', async () => {
    await expect(resetDemoData('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(DemoOrganizationNotFoundError)
  })

  it('recreates the demo organization and admin login, and records an audit entry', async () => {
    await seedDemoOrganization(db)
    const [beforeUser] = await db.select().from(appUser).where(eq(appUser.email, DEMO_ADMIN_EMAIL)).limit(1)

    const result = await resetDemoData(beforeUser.id)

    const authResult = await authenticate(DEMO_ORG_SLUG, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD)
    expect(authResult).not.toBeNull()

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.action, 'DEMO_RESET'))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].organizationId).toBe(result.organizationId)
  })

  it('never touches a real, non-demo organization', async () => {
    await seedDemoOrganization(db)
    const [realOrg] = await db.insert(organization).values({ name: 'Real Customer Inc', slug: 'real-customer-2' }).returning()
    const [realUser] = await db.insert(appUser).values({
      organizationId: realOrg.id,
      email: 'owner@realcustomer.com',
      passwordHash: 'irrelevant-for-this-test',
      fullName: 'Real Owner',
    }).returning()

    const [demoAdmin] = await db.select().from(appUser).where(eq(appUser.email, DEMO_ADMIN_EMAIL)).limit(1)
    await resetDemoData(demoAdmin.id)

    const [stillThere] = await db.select().from(appUser).where(eq(appUser.id, realUser.id)).limit(1)
    expect(stillThere).toBeDefined()
    expect(stillThere.email).toBe('owner@realcustomer.com')
  })
})
