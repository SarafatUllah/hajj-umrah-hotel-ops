import { createDb, type Database } from '../../db/client'
import { getEnv } from './env'

let db: Database | null = null

export function useDb(): Database {
  if (!db) {
    db = createDb(getEnv().DATABASE_URL)
  }
  return db
}
