import 'dotenv/config'
import { createDb } from '../client'
import { seedDemoOrganization } from './demo-org'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const db = createDb(connectionString)
  const { organizationId } = await seedDemoOrganization(db)
  console.log(`Demo organization ready: ${organizationId}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
