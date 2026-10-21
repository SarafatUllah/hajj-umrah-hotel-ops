import 'dotenv/config'
import { createDbWithClient } from '../client'
import { seedDemoOrganization } from './demo-org'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const { db, close } = createDbWithClient(connectionString, { max: 1 })
  try {
    // Replaces the demo organization with the deterministic baseline (same ids), so a second run is idempotent.
    const { organizationId, summary } = await seedDemoOrganization(db)
    console.log(`Demo organization ready: ${organizationId} (anchor ${summary.anchorDate}; ${summary.hotels} hotels, ${summary.rooms} rooms, ${summary.users} users)`)
  }
  finally {
    await close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
