import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { userRole } from '../../../db/schema'
import { resolveAuthContext } from '../../../server/security/authContext'
import { tenantRepos } from '../../../server/repositories'
import { makeHotel, makeOrg, makeUser, makeUserWithPermissions } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

describe('resolveAuthContext', () => {
  it('resolves current permissions, allHotels, and hotelIds for an active user', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const { user } = await makeUserWithPermissions(db, org, ['booking.view', 'booking.create'], { hotelIds: [hotelRow.id] })

    const ctx = await resolveAuthContext(db, { userId: user.id, organizationId: org.organizationId })

    expect(ctx).not.toBeNull()
    expect(ctx?.identity).toEqual({ userId: user.id, organizationId: org.organizationId, email: user.email, fullName: user.fullName })
    expect([...ctx!.authz.permissions].sort()).toEqual(['booking.create', 'booking.view'])
    expect(ctx?.authz.allHotels).toBe(false)
    expect([...ctx!.authz.hotelIds]).toEqual([hotelRow.id])
  })

  it('returns null for an inactive user', async () => {
    const { scope: org } = await makeOrg(db)
    const user = await makeUser(db, org, { isActive: false })

    expect(await resolveAuthContext(db, { userId: user.id, organizationId: org.organizationId })).toBeNull()
  })

  it('returns null for a deleted (nonexistent) user id', async () => {
    const { scope: org } = await makeOrg(db)

    expect(await resolveAuthContext(db, { userId: '00000000-0000-0000-0000-000000000000', organizationId: org.organizationId })).toBeNull()
  })

  it('returns null when the identity organizationId does not match the user\'s real organization', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const user = await makeUser(db, orgA)

    expect(await resolveAuthContext(db, { userId: user.id, organizationId: orgB.organizationId })).toBeNull()
  })

  it('a role revocation is visible on the very next resolve (no snapshot)', async () => {
    const { scope: org } = await makeOrg(db)
    const { user, role: roleRow } = await makeUserWithPermissions(db, org, ['booking.view'])

    const before = await resolveAuthContext(db, { userId: user.id, organizationId: org.organizationId })
    expect([...before!.authz.permissions]).toEqual(['booking.view'])

    await db.delete(userRole).where(and(eq(userRole.userId, user.id), eq(userRole.roleId, roleRow.id)))

    const after = await resolveAuthContext(db, { userId: user.id, organizationId: org.organizationId })
    expect([...after!.authz.permissions]).toEqual([])
  })

  it('a hotel-access revocation is visible on the very next resolve (no snapshot)', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const user = await makeUser(db, org, { hotelIds: [hotelRow.id] })

    const before = await resolveAuthContext(db, { userId: user.id, organizationId: org.organizationId })
    expect([...before!.authz.hotelIds]).toEqual([hotelRow.id])

    await tenantRepos(db, org).userHotelAccess.replaceForUser(user.id, [], null)

    const after = await resolveAuthContext(db, { userId: user.id, organizationId: org.organizationId })
    expect([...after!.authz.hotelIds]).toEqual([])
  })

  it('Phase 0 regression: a forced cross-org user_role row grants nothing', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const { user: userA } = await makeUserWithPermissions(db, orgA, ['home.view'])
    const { role: roleB } = await makeUserWithPermissions(db, orgB, ['foreign.admin'])

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.insert(userRole).values({ organizationId: orgA.organizationId, userId: userA.id, roleId: roleB.id })
    })

    try {
      const planted = await db.select().from(userRole).where(and(eq(userRole.userId, userA.id), eq(userRole.roleId, roleB.id)))
      expect(planted.length).toBe(1)

      const ctx = await resolveAuthContext(db, { userId: userA.id, organizationId: orgA.organizationId })
      expect([...ctx!.authz.permissions]).toEqual(['home.view'])
    }
    finally {
      await db.delete(userRole).where(and(eq(userRole.userId, userA.id), eq(userRole.roleId, roleB.id)))
    }
  })
})
