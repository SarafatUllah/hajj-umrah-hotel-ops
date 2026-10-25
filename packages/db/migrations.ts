import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { databaseSsl } from './ssl'

/** Absolute path of the committed migrations folder, independent of the caller's working directory. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/** Applies every pending migration from `migrationsFolder` (default: the committed folder) and closes its connection. */
export async function runMigrations(connectionString: string, migrationsFolder: string = MIGRATIONS_FOLDER): Promise<void> {
  const client = postgres(connectionString, { max: 1, ssl: databaseSsl(), onnotice: () => {} })
  try {
    await migrate(drizzle(client), { migrationsFolder })
  }
  finally {
    await client.end()
  }
}
