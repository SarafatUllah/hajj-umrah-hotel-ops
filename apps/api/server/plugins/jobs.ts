import { JOBS } from '../jobs'
import { workTiersFor } from '../jobs/definition'
import { wireDomainEvents } from '../jobs/eventJobs'
import { wirePassportReading } from '../jobs/passportJobs'
import { startJobRuntimeWithRetry, stopJobRuntime } from '../jobs/runtime'
import { useDb } from '../utils/db'
import { getEnv } from '../utils/env'

// Starts the background-job runtime with the server (JOBS_MODE, see server/utils/env.ts). A start
// failure is logged and tried again, not fatal: the API keeps serving, and anything that needs to
// enqueue meanwhile fails loudly. (The db plugin stops the runtime before it closes the pool.)
export default defineNitroPlugin((nitro) => {
  const env = getEnv()
  const workTiers = workTiersFor(env.JOBS_MODE)
  if (workTiers === null) return
  startJobRuntimeWithRetry({ connectionString: env.DATABASE_URL, db: useDb(), jobs: JOBS, workTiers, poolMax: env.JOBS_POOL_MAX })
  // Wired at once: `enqueue` waits for the boot, so a request served while it boots loses nothing.
  wirePassportReading()
  wireDomainEvents()
  nitro.hooks.hook('close', stopJobRuntime)
})
