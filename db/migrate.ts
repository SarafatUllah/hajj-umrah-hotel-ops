import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const client = postgres(connectionString, { max: 1 })
  const db = drizzle(client)
  await migrate(db, { migrationsFolder: './db/migrations' })
  await client.end()
  console.log('Migrations applied successfully')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
