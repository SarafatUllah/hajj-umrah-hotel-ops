import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDbWithClient } from '../../../db/client'
import { closeDb, useDb } from '../../../server/utils/db'
import { getTestClient } from './testDb'
import { requireTestDatabaseUrl } from './testDatabase'

afterEach(async () => {
  await closeDb()
})

afterAll(async () => {
  await closeDb()
})

describe('closeDb / useDb lifecycle', () => {
  it('closing twice does not throw', async () => {
    useDb()
    await closeDb()
    await expect(closeDb()).resolves.toBeUndefined()
  })

  it('closing without ever calling useDb() does not throw', async () => {
    await expect(closeDb()).resolves.toBeUndefined()
  })

  it('a later useDb() after closeDb() returns a working handle', async () => {
    const first = useDb()
    await first.execute(sql`select 1`)

    await closeDb()

    const second = useDb()
    const result = await second.execute(sql`select 1`)
    expect(result).toBeDefined()
  })
})

describe('connection pool does not leak', () => {
  it('create-query-close 15 times leaves pg_stat_activity unchanged', async () => {
    const client = getTestClient()
    const connectionString = requireTestDatabaseUrl()

    const countConnections = async () => {
      const rows = await client<Array<{ count: string }>>`
        SELECT count(*)::text AS count
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
      `
      return Number(rows[0].count)
    }

    const before = await countConnections()

    for (let i = 0; i < 15; i++) {
      const { db, close } = createDbWithClient(connectionString, { max: 1 })
      await db.execute(sql`select 1`)
      await close()
    }

    const after = await countConnections()
    expect(after).toBe(before)
  })
})
