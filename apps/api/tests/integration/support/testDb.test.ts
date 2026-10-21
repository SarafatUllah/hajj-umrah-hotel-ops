import { afterAll, describe, expect, it } from 'vitest'
import { closeTestDb, getTestClient, truncateAllTables } from './testDb'
import { requireTestDatabaseUrl } from './testDatabase'

afterAll(async () => {
  await closeTestDb()
})

describe('truncateAllTables', () => {
  it('empties every table in "public", including one the helper has never heard of, without touching drizzle bookkeeping', async () => {
    const client = getTestClient()
    await client.unsafe('CREATE TABLE IF NOT EXISTS zz_truncate_probe (id int)')
    await client`INSERT INTO zz_truncate_probe (id) VALUES (1)`

    try {
      const migrationsBefore = await client`SELECT id FROM drizzle.__drizzle_migrations ORDER BY id`

      await truncateAllTables()

      const probeRows = await client`SELECT * FROM zz_truncate_probe`
      expect(probeRows).toEqual([])

      const migrationsAfter = await client`SELECT id FROM drizzle.__drizzle_migrations ORDER BY id`
      expect(migrationsAfter).toEqual(migrationsBefore)
      expect(migrationsAfter.length).toBeGreaterThan(0)
    }
    finally {
      await client.unsafe('DROP TABLE IF EXISTS zz_truncate_probe')
    }
  })
})

describe('the test-database guard resetTestDb relies on', () => {
  it('refuses a non-"_test" database', () => {
    const original = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5433/hajj_umrah_dev'
    try {
      expect(() => requireTestDatabaseUrl()).toThrow(/hajj_umrah_dev/)
    }
    finally {
      process.env.DATABASE_URL = original
    }
  })
})
