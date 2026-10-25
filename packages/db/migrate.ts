import { loadDbEnv } from './env'
import { runMigrations } from './migrations'

async function main() {
  loadDbEnv()
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  await runMigrations(connectionString)
  console.log('Migrations applied successfully')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
