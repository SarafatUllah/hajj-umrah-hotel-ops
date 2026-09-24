import { afterAll, afterEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { organization, appUser } from '../../../db/schema'
import { requireTestDatabaseUrl } from '../support/testDatabase'

const connectionString = requireTestDatabaseUrl()

const client = postgres(connectionString, { max: 1 })
const db = drizzle(client)

afterEach(async () => {
  await db.execute(sql`TRUNCATE TABLE app_user, organization RESTART IDENTITY CASCADE`)
})

afterAll(async () => {
  await client.end()
})

describe('tenancy schema', () => {
  it('inserts and reads an organization', async () => {
    const [org] = await db.insert(organization).values({ name: 'Al Safa Hajj & Umrah Hotels', slug: 'al-safa' }).returning()
    expect(org.id).toBeDefined()
    expect(org.slug).toBe('al-safa')
  })

  it('rejects a duplicate organization slug', async () => {
    await db.insert(organization).values({ name: 'First', slug: 'dupe-slug' })
    await expect(
      db.insert(organization).values({ name: 'Second', slug: 'dupe-slug' }),
    ).rejects.toThrow()
  })

  it('rejects a duplicate user email within the same organization', async () => {
    const [org] = await db.insert(organization).values({ name: 'Org', slug: 'org-for-user-test' }).returning()
    await db.insert(appUser).values({ organizationId: org.id, email: 'manager@example.com', passwordHash: 'hash', fullName: 'Manager One' })
    await expect(
      db.insert(appUser).values({ organizationId: org.id, email: 'manager@example.com', passwordHash: 'hash2', fullName: 'Manager Two' }),
    ).rejects.toThrow()
  })

  it('allows the same email across different organizations', async () => {
    const [orgA] = await db.insert(organization).values({ name: 'Org A', slug: 'org-a' }).returning()
    const [orgB] = await db.insert(organization).values({ name: 'Org B', slug: 'org-b' }).returning()
    await db.insert(appUser).values({ organizationId: orgA.id, email: 'same@example.com', passwordHash: 'h', fullName: 'A' })
    await expect(
      db.insert(appUser).values({ organizationId: orgB.id, email: 'same@example.com', passwordHash: 'h', fullName: 'B' }),
    ).resolves.toBeDefined()
  })
})
