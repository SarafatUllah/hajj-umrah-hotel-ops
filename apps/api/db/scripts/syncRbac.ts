import 'dotenv/config'
import { createDbWithClient } from '@hajj/db/client'
import { syncRbacForAllOrganizations } from '../seed/rbac'

/**
 * Deploy step after migrations (docs/DEPLOY_CHECKLIST.md): upserts the permission catalog and gives every
 * organization's built-in roles the permissions and 2FA flags their definitions now have
 * (packages/contracts/constants/roles.ts). Idempotent and additive: it never removes a grant, so a later
 * release's new permissions (e.g. Phase 2's agency.manage) reach existing organizations without touching
 * anything else. Demo-only permissions stay with the demo seed.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')
  const { db, close } = createDbWithClient(connectionString, { max: 1 })
  try {
    console.log(`RBAC synced for ${await syncRbacForAllOrganizations(db)} organization(s)`)
  }
  finally {
    await close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
