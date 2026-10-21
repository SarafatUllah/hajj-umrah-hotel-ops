import { JOBS } from '../jobs'
import { workTiersFor } from '../jobs/definition'
import { wirePassportReading } from '../jobs/passportJobs'
import { startJobRuntime, stopJobRuntime } from '../jobs/runtime'
import { useDb } from '../utils/db'
import { getEnv } from '../utils/env'

// Starts the background-job runtime with the server (JOBS_MODE, see server/utils/env.ts). A start
// failure is logged, not fatal: the API keeps serving, and anything that needs to enqueue fails loudly.
export default defineNitroPlugin((nitro) => {
  const env = getEnv()
  const workTiers = workTiersFor(env.JOBS_MODE)
  if (workTiers === null) return
  startJobRuntime({ connectionString: env.DATABASE_URL, db: useDb(), jobs: JOBS, workTiers, poolMax: env.JOBS_POOL_MAX })
    .then(wirePassportReading)
    .catch(error => console.error('[jobs] runtime failed to start', error))
  nitro.hooks.hook('close', stopJobRuntime)
})
