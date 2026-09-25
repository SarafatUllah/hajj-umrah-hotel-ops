import 'dotenv/config'
import { createDbWithClient } from '../client'
import { seedDemoOrganization } from './demo-org'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const { db, close } = createDbWithClient(connectionString, { max: 1 })
  try {
    const { organizationId } = await seedDemoOrganization(db)
    console.log(`Demo organization ready: ${organizationId}`)
  }
  finally {
    await close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
