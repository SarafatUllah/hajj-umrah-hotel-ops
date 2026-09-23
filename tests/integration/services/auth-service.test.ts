import { afterAll, afterEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { organization, appUser, role, permission, rolePermission, userRole } from '../../../db/schema'
import { hashPassword } from '../../../server/utils/password'
import { authenticate } from '../../../server/services/auth.service'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL must be set (run via `dotenv -e .env.test`)')

const client = postgres(connectionString, { max: 1 })
const db = drizzle(client)

afterEach(async () => {
  await db.execute(sql`TRUNCATE TABLE user_role, role_permission, permission, role, app_user, organization RESTART IDENTITY CASCADE`)
})

afterAll(async () => {
  await client.end()
})

describe('authenticate', () => {
  it('returns the user with resolved permissions for correct organization, email, and password', async () => {
    const [org] = await db.insert(organization).values({ name: 'Test Org', slug: 'test-org-auth' }).returning()
    const [managerRole] = await db.insert(role).values({ organizationId: org.id, key: 'HOTEL_MANAGER', name: 'Hotel Manager' }).returning()
    await db.insert(permission).values([
      { key: 'booking.view', description: 'View bookings' },
      { key: 'booking.create', description: 'Create bookings' },
    ])
    await db.insert(rolePermission).values([
      { roleId: managerRole.id, permissionKey: 'booking.view' },
      { roleId: managerRole.id, permissionKey: 'booking.create' },
    ])
    const [user] = await db.insert(appUser).values({
      organizationId: org.id,
      email: 'manager@test.com',
      passwordHash: await hashPassword('correct-password'),
      fullName: 'Test Manager',
    }).returning()
    await db.insert(userRole).values({ userId: user.id, roleId: managerRole.id })

    const result = await authenticate('test-org-auth', 'manager@test.com', 'correct-password')

    expect(result).not.toBeNull()
    expect(result?.user.email).toBe('manager@test.com')
    expect(result?.user.organizationId).toBe(org.id)
    expect(result?.permissions.slice().sort()).toEqual(['booking.create', 'booking.view'])
  })

  it('returns null for an incorrect password', async () => {
    const [org] = await db.insert(organization).values({ name: 'Test Org 2', slug: 'test-org-auth-2' }).returning()
    await db.insert(appUser).values({
      organizationId: org.id,
      email: 'user2@test.com',
      passwordHash: await hashPassword('right-password'),
      fullName: 'User Two',
    })

    expect(await authenticate('test-org-auth-2', 'user2@test.com', 'wrong-password')).toBeNull()
  })

  it('returns null for an unknown email within a known organization', async () => {
    await db.insert(organization).values({ name: 'Test Org 3', slug: 'test-org-auth-3' })
    expect(await authenticate('test-org-auth-3', 'nobody@test.com', 'whatever')).toBeNull()
  })

  it('returns null for an unknown organization slug', async () => {
    expect(await authenticate('no-such-org', 'anyone@test.com', 'whatever')).toBeNull()
  })

  it('returns null for an inactive user', async () => {
    const [org] = await db.insert(organization).values({ name: 'Test Org 4', slug: 'test-org-auth-4' }).returning()
    await db.insert(appUser).values({
      organizationId: org.id,
      email: 'inactive@test.com',
      passwordHash: await hashPassword('some-password'),
      fullName: 'Inactive User',
      isActive: false,
    })

    expect(await authenticate('test-org-auth-4', 'inactive@test.com', 'some-password')).toBeNull()
  })

  it('never authenticates a user against the wrong organization, even when the same email exists in both', async () => {
    const [orgA] = await db.insert(organization).values({ name: 'Org A', slug: 'org-a-auth' }).returning()
    const [orgB] = await db.insert(organization).values({ name: 'Org B', slug: 'org-b-auth' }).returning()
    await db.insert(appUser).values({
      organizationId: orgA.id,
      email: 'shared@example.com',
      passwordHash: await hashPassword('org-a-password'),
      fullName: 'Org A User',
    })
    await db.insert(appUser).values({
      organizationId: orgB.id,
      email: 'shared@example.com',
      passwordHash: await hashPassword('org-b-password'),
      fullName: 'Org B User',
    })

    // Correct org + that org's own password succeeds.
    const orgAResult = await authenticate('org-a-auth', 'shared@example.com', 'org-a-password')
    expect(orgAResult?.user.organizationId).toBe(orgA.id)

    // Same email, but org A's password against org B must fail — this is
    // exactly the cross-tenant leak a global email lookup would allow.
    expect(await authenticate('org-b-auth', 'shared@example.com', 'org-a-password')).toBeNull()

    // Org B's own password against org B succeeds and resolves to org B.
    const orgBResult = await authenticate('org-b-auth', 'shared@example.com', 'org-b-password')
    expect(orgBResult?.user.organizationId).toBe(orgB.id)
  })
})
