import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

function buildDb(client: postgres.Sql) {
  return drizzle(client, { schema })
}

export type Database = ReturnType<typeof buildDb>

export interface DbHandle {
  db: Database
  close: () => Promise<void>
}

/**
 * Builds a Drizzle handle together with the `close()` needed to end its
 * underlying connection pool cleanly (used by long-lived server code and by
 * one-off scripts that must not leave the process hanging on an open pool).
 */
export function createDbWithClient(connectionString: string, options?: { max?: number }): DbHandle {
  const client = postgres(connectionString, {
    max: options?.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  })
  return { db: buildDb(client), close: () => client.end({ timeout: 5 }) }
}

// Unchanged signature, kept for scripts that only need the Drizzle handle
// and manage the process lifecycle themselves (e.g. short migration runs).
export function createDb(connectionString: string, options?: { max?: number }): Database {
  return createDbWithClient(connectionString, options).db
}

// The transaction handle type, extracted from Database['transaction']'s own
// callback signature so no Drizzle-internal generic (PgTransaction<...>) has
// to be named by hand. Seed functions accept DbOrTx so they can run either
// standalone or inside a caller's transaction (e.g. the demo reset).
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type DbOrTx = Database | Tx
