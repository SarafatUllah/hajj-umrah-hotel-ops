import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { organization, appUser, role, permission, rolePermission, userRole } from '../../../db/schema'
import { hashPassword } from '../../../server/utils/password'
import { authenticate } from '../../../server/services/auth.service'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
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
    await db.insert(userRole).values({ organizationId: org.id, userId: user.id, roleId: managerRole.id })

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

  it('never grants permissions from a role in another organization, even if a cross-org user_role row exists', async () => {
    const [homeOrg] = await db.insert(organization).values({ name: 'Home Org', slug: 'home-org-auth' }).returning()
    const [otherOrg] = await db.insert(organization).values({ name: 'Other Org', slug: 'other-org-auth' }).returning()
    await db.insert(permission).values([
      { key: 'booking.view', description: 'View bookings' },
      { key: 'user.manage', description: 'Manage users' },
    ])
    const [homeRole] = await db.insert(role).values({ organizationId: homeOrg.id, key: 'VIEWER', name: 'Viewer' }).returning()
    const [otherAdminRole] = await db.insert(role).values({ organizationId: otherOrg.id, key: 'SUPER_ADMIN', name: 'Super Admin' }).returning()
    await db.insert(rolePermission).values([
      { roleId: homeRole.id, permissionKey: 'booking.view' },
      { roleId: otherAdminRole.id, permissionKey: 'user.manage' },
    ])
    const [user] = await db.insert(appUser).values({
      organizationId: homeOrg.id,
      email: 'viewer@home.test',
      passwordHash: await hashPassword('home-password'),
      fullName: 'Home Viewer',
    }).returning()
    // The legitimate grant.
    await db.insert(userRole).values({ organizationId: homeOrg.id, userId: user.id, roleId: homeRole.id })

    // A corrupt cross-tenant link. Since migration 0001 the composite FK
    // user_role_org_role_fk rejects it, so it is planted with FK triggers
    // disabled for this one transaction only (SET LOCAL ends with it). It
    // must be committed: authenticate() reads through its own connection
    // pool and could not see an uncommitted row. It is removed right after
    // the assertion (and afterEach truncates everything regardless).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.insert(userRole).values({ organizationId: homeOrg.id, userId: user.id, roleId: otherAdminRole.id })
    })

    try {
      const planted = await db.select().from(userRole).where(and(eq(userRole.userId, user.id), eq(userRole.roleId, otherAdminRole.id)))
      expect(planted.length).toBe(1)

      const result = await authenticate('home-org-auth', 'viewer@home.test', 'home-password')

      expect(result?.permissions).toEqual(['booking.view'])
    }
    finally {
      await db.delete(userRole).where(and(eq(userRole.userId, user.id), eq(userRole.roleId, otherAdminRole.id)))
    }
  })

  it('matches email case-insensitively', async () => {
    const [org] = await db.insert(organization).values({ name: 'Case Org', slug: 'case-org-auth' }).returning()
    await db.insert(appUser).values({
      organizationId: org.id,
      email: 'mixed.case@test.com',
      passwordHash: await hashPassword('case-password'),
      fullName: 'Case User',
    })

    const result = await authenticate('case-org-auth', '  Mixed.Case@TEST.com ', 'case-password')

    expect(result?.user.email).toBe('mixed.case@test.com')
  })
})
