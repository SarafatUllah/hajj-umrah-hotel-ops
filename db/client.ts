import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 10 })
  return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDb>

// The transaction handle type, extracted from Database['transaction']'s own
// callback signature so no Drizzle-internal generic (PgTransaction<...>) has
// to be named by hand. Seed functions accept DbOrTx so they can run either
// standalone or inside a caller's transaction (e.g. the demo reset).
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type DbOrTx = Database | Tx
