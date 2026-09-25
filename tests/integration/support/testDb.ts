import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '../../../db/schema'
import { requireTestDatabaseUrl } from './testDatabase'

let client: postgres.Sql | null = null

/**
 * One shared connection per test file (vitest runs each test file in its own
 * worker/module registry, so this module-level singleton is per-file, not
 * global). Replaces every integration test building its own `postgres()`
 * client.
 */
export function getTestClient(): postgres.Sql {
  client ??= postgres(requireTestDatabaseUrl(), { max: 4, onnotice: () => {} })
  return client
}

export function getTestDb(): PostgresJsDatabase<typeof schema> {
  return drizzle(getTestClient(), { schema })
}

/**
 * Truncates every table in "public", discovered from the catalog (not a
 * hard-coded list), so a table added later can never be forgotten by a test
 * file's cleanup. Leaves the "drizzle" bookkeeping schema untouched.
 */
export async function truncateAllTables(): Promise<void> {
  const c = getTestClient()
  const rows = await c<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  if (rows.length === 0) return
  const list = rows.map(r => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ')
  await c.unsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
}

export async function closeTestDb(): Promise<void> {
  if (client) {
    await client.end()
    client = null
  }
}
