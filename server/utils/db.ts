import { sql } from 'drizzle-orm'
import { createDbWithClient, type Database, type DbHandle } from '../../db/client'
import { getEnv } from './env'

let handle: DbHandle | null = null

export function useDb(): Database {
  if (!handle) {
    handle = createDbWithClient(getEnv().DATABASE_URL, { max: getEnv().DATABASE_POOL_MAX })
  }
  return handle.db
}

/**
 * Health-check DB connectivity (`GET /api/health`, server/api/health.get.ts). This file is the one
 * lint-exempt place `server/api/**` is allowed to reach for a raw query (PF-16) — every other route
 * goes through a repository. Throws on failure; the caller decides the HTTP status.
 */
export async function pingDb(): Promise<void> {
  await useDb().execute(sql`select 1`)
}

// Idempotent: a second call while already closed (or before useDb() was ever
// called) is a no-op. A later useDb() call builds a fresh handle.
export async function closeDb(): Promise<void> {
  if (!handle) return
  const current = handle
  handle = null
  await current.close()
}
