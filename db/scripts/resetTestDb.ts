import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { requireTestDatabaseUrl } from '../../tests/integration/support/testDatabase'

/**
 * Rebuilds the test database from nothing: drops the "public" schema (every
 * table, including any leftover from a broken migration) and the "drizzle"
 * schema (Drizzle's own migration bookkeeping, see
 * `drizzle.__drizzle_migrations`), recreates "public", then replays every
 * migration from scratch. Refuses to run against anything but a database
 * whose name ends in "_test" (see requireTestDatabaseUrl) so it can never be
 * pointed at the dev database.
 */
async function main() {
  const connectionString = requireTestDatabaseUrl()
  const client = postgres(connectionString, { max: 1, onnotice: () => {} })

  await client.unsafe('DROP SCHEMA IF EXISTS public CASCADE')
  await client.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE')
  await client.unsafe('CREATE SCHEMA public')

  const db = drizzle(client)
  await migrate(db, { migrationsFolder: './db/migrations' })
  await client.end()
  console.log('Test database reset and migrated successfully')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
