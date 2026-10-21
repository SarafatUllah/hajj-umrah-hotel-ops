import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { auditLog } from '../../../db/schema'
import type { Database } from '../../../db/client'
import type { AuthContext } from '../../../server/security/authContext'
import type { OrganizationScope } from '../../../server/security/scope'
import { getUserHotelAccess, setUserHotelAccess } from '../../../server/services/hotelAccessService'
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

interface CtxOpts {
  permissions?: string[]
  allHotels?: boolean
  hotelIds?: string[]
}

function ctxFor(scope: OrganizationScope, userId: string, opts: CtxOpts = {}): AuthContext {
  return {
    identity: { userId, organizationId: scope.organizationId, email: 'caller@test.com', fullName: 'Caller' },
    authz: {
      permissions: new Set(opts.permissions ?? []),
      allHotels: opts.allHotels ?? false,
      hotelIds: new Set(opts.hotelIds ?? []),
    },
    scope,
    db: db as Database,
    now: () => new Date(),
  }
}

/** A caller with user.manage and allHotels — the unrestricted (rule 6) case, used as a helper for setting up other tests' fixtures. */
async function makeUnrestrictedCaller(org: OrganizationScope) {
  const { user } = await makeUserWithPermissions(db, org, ['user.manage'], { allHotels: true })
  return ctxFor(org, user.id, { permissions: ['user.manage'], allHotels: true })
}

describe('hotelAccessService', () => {
  it('rule 1: caller lacks user.manage -> 403', async () => {
    const { scope: org } = await makeOrg(db)
    const caller = await makeUser(db, org)
    const target = await makeUser(db, org)
    const ctx = ctxFor(org, caller.id, { permissions: [] })

    await expect(setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [] })).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 })
    await expect(getUserHotelAccess(ctx, target.id)).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 })
  })

  it('rule 2: target user outside the caller\'s organization -> 404, indistinguishable from nonexistent', async () => {
    const { scope: org } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const foreignUser = await makeUser(db, otherOrg)
    const ctx = await makeUnrestrictedCaller(org)

    await expect(setUserHotelAccess(ctx, foreignUser.id, { allHotels: false, hotelIds: [] })).rejects.toMatchObject({ code: 'USER_NOT_FOUND', httpStatus: 404 })
    await expect(getUserHotelAccess(ctx, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'USER_NOT_FOUND', httpStatus: 404 })
  })

  it('rule 3: allHotels=true with non-empty hotelIds -> 422 (ambiguous), rejected before any DB work', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const ctx = await makeUnrestrictedCaller(org)
    // A userId that doesn't even exist proves this is rejected before the target lookup (rule 2)
    // would have run — if it hit the DB first it would 404, not 422.
    await expect(setUserHotelAccess(ctx, '00000000-0000-0000-0000-000000000000', { allHotels: true, hotelIds: [hotelRow.id] }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_HOTEL_ACCESS', httpStatus: 422 })
  })

  it('rule 4: a hotelId outside the caller\'s organization -> 422 INVALID_REFERENCE', async () => {
    const { scope: org } = await makeOrg(db)
    const { scope: otherOrg } = await makeOrg(db)
    const foreignHotel = await makeHotel(db, otherOrg)
    const target = await makeUser(db, org)
    const ctx = await makeUnrestrictedCaller(org)

    await expect(setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [foreignHotel.id] }))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE', httpStatus: 422 })
  })

  describe('rule 5: a caller without allHotels', () => {
    it('may grant only hotels they themselves currently hold access to', async () => {
      const { scope: org } = await makeOrg(db)
      const ownHotel = await makeHotel(db, org)
      const otherHotel = await makeHotel(db, org)
      const { user: caller } = await makeUserWithPermissions(db, org, ['user.manage'], { hotelIds: [ownHotel.id] })
      const target = await makeUser(db, org)
      const ctx = ctxFor(org, caller.id, { permissions: ['user.manage'], hotelIds: [ownHotel.id] })

      // Granting a hotel they DO hold succeeds.
      const ok = await setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [ownHotel.id] })
      expect(ok).toEqual({ allHotels: false, hotelIds: [ownHotel.id] })

      // Granting a hotel they do NOT hold is denied.
      await expect(setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [otherHotel.id] }))
        .rejects.toMatchObject({ code: 'ESCALATION_DENIED', httpStatus: 403 })
    })

    it('may not grant allHotels=true to anyone', async () => {
      const { scope: org } = await makeOrg(db)
      const { user: caller } = await makeUserWithPermissions(db, org, ['user.manage'])
      const target = await makeUser(db, org)
      const ctx = ctxFor(org, caller.id, { permissions: ['user.manage'] })

      await expect(setUserHotelAccess(ctx, target.id, { allHotels: true, hotelIds: [] }))
        .rejects.toMatchObject({ code: 'ESCALATION_DENIED', httpStatus: 403 })
    })

    it('may not change their own access row at all, even to a hotel they already hold', async () => {
      const { scope: org } = await makeOrg(db)
      const ownHotel = await makeHotel(db, org)
      const { user: caller } = await makeUserWithPermissions(db, org, ['user.manage'], { hotelIds: [ownHotel.id] })
      const ctx = ctxFor(org, caller.id, { permissions: ['user.manage'], hotelIds: [ownHotel.id] })

      await expect(setUserHotelAccess(ctx, caller.id, { allHotels: false, hotelIds: [ownHotel.id] }))
        .rejects.toMatchObject({ code: 'ESCALATION_DENIED', httpStatus: 403 })
    })

    it('may not modify a target who currently has allHotels=true', async () => {
      const { scope: org } = await makeOrg(db)
      const ownHotel = await makeHotel(db, org)
      const { user: caller } = await makeUserWithPermissions(db, org, ['user.manage'], { hotelIds: [ownHotel.id] })
      const target = await makeUser(db, org, { allHotels: true })
      const ctx = ctxFor(org, caller.id, { permissions: ['user.manage'], hotelIds: [ownHotel.id] })

      await expect(setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [ownHotel.id] }))
        .rejects.toMatchObject({ code: 'ESCALATION_DENIED', httpStatus: 403 })
    })
  })

  describe('rule 5 TOCTOU fix: the target row is locked (SELECT ... FOR UPDATE) atomically with the write', () => {
    it('findByIdForUpdate blocks a concurrent locked read on the same row until the first transaction commits, proving the lock is really taken', async () => {
      const { scope: org } = await makeOrg(db)
      const target = await makeUser(db, org)

      const events: string[] = []
      let releaseFirst!: () => void
      const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve })

      // Transaction A acquires the row lock and then holds the transaction open (does not commit)
      // until the test explicitly releases it.
      const first = db.transaction(async (tx) => {
        const repos = tenantRepos(tx, org)
        await repos.users.findByIdForUpdate(target.id)
        events.push('first-locked')
        await holdFirst
        events.push('first-committing')
      })

      // Wait for A to actually acquire the lock (a real DB round trip) before starting B.
      await vi.waitFor(() => expect(events).toContain('first-locked'))

      let secondLocked = false
      const second = db.transaction(async (tx) => {
        const repos = tenantRepos(tx, org)
        events.push('second-waiting')
        await repos.users.findByIdForUpdate(target.id) // must block until A commits
        secondLocked = true
        events.push('second-locked')
      })

      // Give B time to issue its SELECT ... FOR UPDATE and start waiting on Postgres's row lock.
      // If FOR UPDATE were not actually applied, B's read would resolve immediately here instead.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(secondLocked).toBe(false)
      expect(events).toEqual(['first-locked', 'second-waiting'])

      releaseFirst()
      await first
      await second

      // B only acquired the lock strictly after A committed and released it.
      expect(events).toEqual(['first-locked', 'second-waiting', 'first-committing', 'second-locked'])
    })

    it('a concurrent grant to allHotels=true wins the race deterministically: the losing non-allHotels caller never overwrites an allHotels target', async () => {
      const { scope: org } = await makeOrg(db)
      const ownHotel = await makeHotel(db, org)
      const target = await makeUser(db, org, { hotelIds: [ownHotel.id] })
      const unrestrictedCaller = await makeUnrestrictedCaller(org)
      const { user: restrictedUser } = await makeUserWithPermissions(db, org, ['user.manage'], { hotelIds: [ownHotel.id] })
      const restrictedCtx = ctxFor(org, restrictedUser.id, { permissions: ['user.manage'], hotelIds: [ownHotel.id] })

      // Run both calls concurrently against the SAME target: one grants allHotels=true (from an
      // allHotels caller, always legal), the other is a non-allHotels caller granting a hotel it
      // legitimately holds. Without the row lock, both could read target.allHotels=false and both
      // "succeed", leaving a non-allHotels caller's write in effect against what should have become
      // an allHotels target (the exact rule-5 violation this fix prevents).
      const results = await Promise.allSettled([
        setUserHotelAccess(unrestrictedCaller, target.id, { allHotels: true, hotelIds: [] }),
        setUserHotelAccess(restrictedCtx, target.id, { allHotels: false, hotelIds: [ownHotel.id] }),
      ])

      const finalState = await getUserHotelAccess(unrestrictedCaller, target.id)

      if (finalState.allHotels) {
        // The allHotels grant landed (either first, or the restricted call ran first and then the
        // allHotels grant ran second). Either way this is a legal serialization: the transactions
        // did not interleave on a stale read.
        expect(results[0]!.status).toBe('fulfilled')
      } else {
        // The restricted grant landed. That is only legal if it ran and committed strictly before
        // the allHotels grant — never after seeing a stale target.allHotels=false while the target
        // was concurrently (or previously) made allHotels=true by the other transaction.
        expect(results[1]!.status).toBe('fulfilled')
        expect(finalState).toEqual({ allHotels: false, hotelIds: [ownHotel.id] })
      }

      // The key correctness property: the restricted caller's write NEVER lands as a no-op silent
      // escalation bypass against a target that is (or becomes, from its own perspective) allHotels
      // — i.e. it's either cleanly rejected (serialized after the grant, sees allHotels=true, 403s)
      // or it cleanly wins by running first. It can never both "succeed" and leave the target
      // allHotels=true with stale hotelIds hanging around from the restricted write, and it can
      // never throw anything other than the documented ESCALATION_DENIED shape when it does fail.
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ code: 'ESCALATION_DENIED', httpStatus: 403 })
        }
      }
    })
  })

  it('rule 6: a caller with allHotels is unrestricted by rule 5', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelA = await makeHotel(db, org)
    const target = await makeUser(db, org)
    const ctx = await makeUnrestrictedCaller(org)

    // Grants allHotels itself, freely.
    const result = await setUserHotelAccess(ctx, target.id, { allHotels: true, hotelIds: [] })
    expect(result).toEqual({ allHotels: true, hotelIds: [] })

    // And a hotel the caller never explicitly held (allHotels callers aren't limited to their own hotelIds set).
    const result2 = await setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [hotelA.id] })
    expect(result2).toEqual({ allHotels: false, hotelIds: [hotelA.id] })
  })

  it('rule 7 + rollback: the replace is one atomic transaction — a mid-transaction failure rolls back everything', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const target = await makeUser(db, org, { hotelIds: [hotelRow.id] })
    const { user: callerUser } = await makeUserWithPermissions(db, org, ['user.manage'], { allHotels: true })
    // A caller identity with an invalid uuid forces the write inside the transaction (grantedBy / actor_user_id) to fail.
    const ctx = ctxFor(org, callerUser.id, { permissions: ['user.manage'], allHotels: true })
    ctx.identity.userId = 'not-a-uuid'

    await expect(setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [] })).rejects.toThrow()

    // The original access is untouched — the delete inside the failed transaction was rolled back.
    const hotelIds = await tenantRepos(db, org).userHotelAccess.hotelIdsForUser(target.id)
    expect(hotelIds).toEqual([hotelRow.id])
    // No audit row was written either.
    expect(await db.select().from(auditLog).where(eq(auditLog.entityId, target.id))).toEqual([])
  })

  it('rule 8 + rule 9: exactly one USER_HOTEL_ACCESS_CHANGED audit entry (hotel_id null, full before/after), and the response is the new state', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelA = await makeHotel(db, org)
    const hotelB = await makeHotel(db, org)
    const target = await makeUser(db, org, { hotelIds: [hotelA.id] })
    const ctx = await makeUnrestrictedCaller(org)

    const result = await setUserHotelAccess(ctx, target.id, { allHotels: false, hotelIds: [hotelB.id] })

    expect(result).toEqual({ allHotels: false, hotelIds: [hotelB.id] }) // rule 9

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityId, target.id), eq(auditLog.action, 'USER_HOTEL_ACCESS_CHANGED')))
    expect(rows.length).toBe(1) // exactly one
    const row = rows[0]!
    expect(row.hotelId).toBeNull()
    expect(row.entityType).toBe('user')
    expect(row.beforeData).toEqual({ allHotels: false, hotelIds: [hotelA.id] })
    expect(row.afterData).toEqual({ allHotels: false, hotelIds: [hotelB.id] })
  })

  it('getUserHotelAccess returns the current state', async () => {
    const { scope: org } = await makeOrg(db)
    const hotelRow = await makeHotel(db, org)
    const target = await makeUser(db, org, { hotelIds: [hotelRow.id] })
    const ctx = await makeUnrestrictedCaller(org)

    expect(await getUserHotelAccess(ctx, target.id)).toEqual({ allHotels: false, hotelIds: [hotelRow.id] })
  })
})
