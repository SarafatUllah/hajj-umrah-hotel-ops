import { createDbWithClient, type Database, type DbHandle } from '../../db/client'
import { getEnv } from './env'

let handle: DbHandle | null = null

export function useDb(): Database {
  if (!handle) {
    handle = createDbWithClient(getEnv().DATABASE_URL, { max: getEnv().DATABASE_POOL_MAX })
  }
  return handle.db
}

// Idempotent: a second call while already closed (or before useDb() was ever
// called) is a no-op. A later useDb() call builds a fresh handle.
export async function closeDb(): Promise<void> {
  if (!handle) return
  const current = handle
  handle = null
  await current.close()
}
