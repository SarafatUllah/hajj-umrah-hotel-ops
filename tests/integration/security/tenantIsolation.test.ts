import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { userRole } from '../../../db/schema'
import { RoleRepository, UserRepository } from '../../../server/repositories/tenant'
import { makeOrg, makeUser, makeUserWithPermissions } from '../../support/fixtures'
import { closeTestDb, getTestDb, truncateAllTables } from '../support/testDb'
import { coverageGaps, ISOLATION_REGISTRY, registryCases, REPOSITORY_BARRELS, type IsolationExpectation } from './repositoryRegistry'

const db = getTestDb()
const ROOT = join(import.meta.dirname, '../../..')

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

async function outcome(call: () => Promise<unknown>): Promise<{ ok: true, value: unknown } | { ok: false, error: unknown }> {
  try {
    return { ok: true, value: await call() }
  }
  catch (error) {
    return { ok: false, error }
  }
}

function assertIsolated(expectation: IsolationExpectation, result: Awaited<ReturnType<typeof outcome>>) {
  if (expectation === 'rejects') {
    expect(result.ok, 'expected the call to reject').toBe(false)
    return
  }
  if (!result.ok) throw result.error
  if (expectation === 'null') expect(result.value).toBeNull()
  if (expectation === 'empty') expect(result.value).toEqual([])
  if (expectation === 'zero-affected') expect(result.value).toBe(0)
}

function assertNotIsolated(expectation: IsolationExpectation, result: Awaited<ReturnType<typeof outcome>>) {
  if (!result.ok) throw result.error
  if (expectation === 'null') expect(result.value).not.toBeNull()
  if (expectation === 'empty') expect((result.value as unknown[]).length).toBeGreaterThan(0)
  if (expectation === 'zero-affected') expect(result.value).toBeGreaterThan(0)
}

describe('tenant isolation registry (every scoped repository method)', () => {
  const cases = registryCases()

  it.each(cases)('$key: org B cannot reach org A\'s data', async ({ case: c }) => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const ids = await c.arrange(db, orgA)

    const result = await outcome(() => c.act(db, orgB, ids))

    assertIsolated(c.expect, result)
    if (!result.ok && c.rejection) expect(c.rejection(result.error), `unexpected rejection: ${String(result.error)}`).toBe(true)
    await c.unchanged?.(db, ids)
  })

  it.each(cases)('$key: positive control — org A reaches its own data', async ({ case: c }) => {
    const { scope: orgA } = await makeOrg(db)
    await makeOrg(db)
    const ids = await c.arrange(db, orgA)

    assertNotIsolated(c.expect, await outcome(() => c.act(db, orgA, ids)))
  })
})

describe('registry coverage', () => {
  async function loadBarrels() {
    return Promise.all(REPOSITORY_BARRELS.map(b => b.load()))
  }

  it('every method of every exported *Repository class has an isolation case, and no entry is stale', async () => {
    expect(coverageGaps(await loadBarrels(), ISOLATION_REGISTRY)).toEqual({ missing: [], stale: [] })
  })

  it('fails when a repository class is added without registry entries', async () => {
    class ThrowawayRepository {
      findEverything() { return [] }
      wipe() { return 0 }
    }
    class BaseThrowawayRepository {
      inherited() { return null }
    }
    class DerivedThrowawayRepository extends BaseThrowawayRepository {}

    const gaps = coverageGaps([...await loadBarrels(), { ThrowawayRepository, DerivedThrowawayRepository, helper: () => 1 }], ISOLATION_REGISTRY)

    expect(gaps.missing).toEqual(['DerivedThrowawayRepository.inherited', 'ThrowawayRepository.findEverything', 'ThrowawayRepository.wipe'])
  })

  it('every *Repository exported by a module in a barrel directory is exported by the barrel', async () => {
    for (const barrel of REPOSITORY_BARRELS) {
      const barrelExports = new Set(Object.keys(await barrel.load()))
      const files = readdirSync(join(ROOT, barrel.dir)).filter(f => f.endsWith('.ts') && f !== 'index.ts')
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const mod = await import(join(ROOT, barrel.dir, file)) as Record<string, unknown>
        const repositories = Object.keys(mod).filter(name => name.endsWith('Repository'))
        expect(repositories.filter(name => !barrelExports.has(name)), `${barrel.dir}/${file}`).toEqual([])
      }
    }
  })
})

describe('tenant isolation: targeted cases', () => {
  it('findActiveByEmail with the same email in orgs A and B returns only the scoped org\'s user', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const userA = await makeUser(db, orgA, { email: 'shared@example.test' })
    const userB = await makeUser(db, orgB, { email: 'shared@example.test' })

    expect((await new UserRepository(db, orgA).findActiveByEmail('shared@example.test'))?.id).toBe(userA.id)
    expect((await new UserRepository(db, orgB).findActiveByEmail('shared@example.test'))?.id).toBe(userB.id)
  })

  it('Phase 0 regression: a cross-org user_role row (FK bypassed) grants none of the other org\'s permissions', async () => {
    const { scope: orgA } = await makeOrg(db)
    const { scope: orgB } = await makeOrg(db)
    const { user: userA } = await makeUserWithPermissions(db, orgA, ['home.view'])
    const { role: roleB } = await makeUserWithPermissions(db, orgB, ['foreign.admin'])

    class Rollback extends Error {}
    await expect(db.transaction(async (tx) => {
      // Bypass the composite FKs for this transaction only, so the query-level guard is tested on its own.
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.insert(userRole).values({ organizationId: orgA.organizationId, userId: userA.id, roleId: roleB.id })
      const planted = await tx.select().from(userRole).where(and(eq(userRole.userId, userA.id), eq(userRole.roleId, roleB.id)))
      expect(planted).toHaveLength(1)

      expect(await new RoleRepository(tx, orgA).permissionKeysForUser(userA.id)).toEqual(['home.view'])
      throw new Rollback()
    })).rejects.toBeInstanceOf(Rollback)

    expect(await db.select().from(userRole).where(eq(userRole.roleId, roleB.id))).toHaveLength(1)
  })
})
