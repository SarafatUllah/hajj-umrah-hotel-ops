import { describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { migrateAll, migrateThrough, withScratchDatabase } from '../support/migrationHarness'

const SCRATCH_DB = 'hajj_umrah_migrate_test'

async function withClient<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    return await fn(sql)
  }
  finally {
    await sql.end()
  }
}

interface TwoOrgs {
  orgA: string
  orgB: string
  userA: string
  userB: string
  roleA: string
  roleB: string
}

// Plain SQL that is valid against both the Phase 0 schema (0000) and the
// hardened one: none of these tables change shape in 0001.
async function insertTwoOrgs(sql: postgres.Sql): Promise<TwoOrgs> {
  const [{ id: orgA }] = await sql<Array<{ id: string }>>`INSERT INTO organization (name, slug) VALUES ('Org A', 'org-a') RETURNING id`
  const [{ id: orgB }] = await sql<Array<{ id: string }>>`INSERT INTO organization (name, slug) VALUES ('Org B', 'org-b') RETURNING id`
  const [{ id: userA }] = await sql<Array<{ id: string }>>`
    INSERT INTO app_user (organization_id, email, password_hash, full_name) VALUES (${orgA}, 'a@example.test', 'h', 'User A') RETURNING id`
  const [{ id: userB }] = await sql<Array<{ id: string }>>`
    INSERT INTO app_user (organization_id, email, password_hash, full_name) VALUES (${orgB}, 'b@example.test', 'h', 'User B') RETURNING id`
  const [{ id: roleA }] = await sql<Array<{ id: string }>>`
    INSERT INTO role (organization_id, key, name) VALUES (${orgA}, 'VIEWER', 'Viewer') RETURNING id`
  const [{ id: roleB }] = await sql<Array<{ id: string }>>`
    INSERT INTO role (organization_id, key, name) VALUES (${orgB}, 'SUPER_ADMIN', 'Super Admin') RETURNING id`
  return { orgA, orgB, userA, userB, roleA, roleB }
}

describe('migration 0001 (tenancy hardening)', () => {
  it('creates btree_gist itself on a fresh database', async () => {
    await withScratchDatabase(SCRATCH_DB, async (url) => {
      await migrateAll(url)

      await withClient(url, async (sql) => {
        const rows = await sql`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`
        expect(rows.length).toBe(1)
      })
    })
  })

  it('backfills user_role.organization_id from the user and purges cross-organization grants', async () => {
    await withScratchDatabase(SCRATCH_DB, async (url) => {
      await migrateThrough(url, 0)

      const ids = await withClient(url, async (sql) => {
        const ids = await insertTwoOrgs(sql)
        // Phase 0 schema: user_role has no organization_id, and nothing stops
        // user A (org A) from holding org B's SUPER_ADMIN role.
        await sql`INSERT INTO user_role (user_id, role_id) VALUES (${ids.userA}, ${ids.roleA}), (${ids.userA}, ${ids.roleB})`
        return ids
      })

      await migrateAll(url)

      await withClient(url, async (sql) => {
        const rows = await sql<Array<{ userId: string, roleId: string, organizationId: string }>>`
          SELECT user_id AS "userId", role_id AS "roleId", organization_id AS "organizationId" FROM user_role`
        expect(rows).toEqual([{ userId: ids.userA, roleId: ids.roleA, organizationId: ids.orgA }])
      })
    })
  })

  it('rejects a user_role row whose role or user belongs to another organization', async () => {
    await withScratchDatabase(SCRATCH_DB, async (url) => {
      await migrateAll(url)

      await withClient(url, async (sql) => {
        const ids = await insertTwoOrgs(sql)

        // Role side: org A's user granted org B's role.
        await expect(
          sql`INSERT INTO user_role (organization_id, user_id, role_id) VALUES (${ids.orgA}, ${ids.userA}, ${ids.roleB})`,
        ).rejects.toMatchObject({ code: '23503', constraint_name: 'user_role_org_role_fk' })

        // User side: org B's user granted org A's role.
        await expect(
          sql`INSERT INTO user_role (organization_id, user_id, role_id) VALUES (${ids.orgA}, ${ids.userB}, ${ids.roleA})`,
        ).rejects.toMatchObject({ code: '23503', constraint_name: 'user_role_org_user_fk' })

        // The legitimate same-organization grant is still accepted.
        await sql`INSERT INTO user_role (organization_id, user_id, role_id) VALUES (${ids.orgA}, ${ids.userA}, ${ids.roleA})`
        const [{ count }] = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM user_role`
        expect(count).toBe(1)
      })
    })
  })

  it('adds the (organization_id, id) unique constraints the composite foreign keys reference', async () => {
    await withScratchDatabase(SCRATCH_DB, async (url) => {
      await migrateAll(url)

      await withClient(url, async (sql) => {
        const rows = await sql<Array<{ tableName: string, constraintName: string }>>`
          SELECT table_name AS "tableName", constraint_name AS "constraintName"
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND constraint_type = 'UNIQUE'
            AND constraint_name IN ('app_user_org_id_unique', 'role_org_id_unique')
          ORDER BY constraint_name`
        expect(rows).toEqual([
          { tableName: 'app_user', constraintName: 'app_user_org_id_unique' },
          { tableName: 'role', constraintName: 'role_org_id_unique' },
        ])
      })
    })
  })
})
