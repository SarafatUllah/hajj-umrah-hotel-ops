import 'dotenv/config'
import { JOBS } from '../server/jobs'
import { workerTiersFor } from '../server/jobs/definition'
import { wireDomainEvents } from '../server/jobs/eventJobs'
import { wirePassportReading } from '../server/jobs/passportJobs'
import { startJobRuntime, stopJobRuntime } from '../server/jobs/runtime'
import { closeDb, useDb } from '../server/utils/db'
import { getEnv } from '../server/utils/env'

/**
 * The background worker process (design v7 §2: passport OCR runs in its own process from day one, so a
 * burst of CPU-heavy jobs never slows API requests). By default it works only the `heavy` tier and light jobs
 * run in the API processes (JOBS_MODE=light); with WORKER_JOBS=all it works every queue, for hosts whose API
 * processes only enqueue (D-P2-67). Start with `pnpm --filter @hajj/api worker`.
 */
async function main(): Promise<void> {
  const env = getEnv()
  const workTiers = workerTiersFor(env.WORKER_JOBS)
  // The application pool the services already share (useDb), so a job handler that reaches it opens no second pool.
  const db = useDb()
  try {
    await startJobRuntime({ connectionString: env.DATABASE_URL, db, jobs: JOBS, workTiers, poolMax: env.JOBS_POOL_MAX, pollingIntervalSeconds: env.JOBS_POLL_SECONDS })
    // Wired as in the API process, so a job that publishes a domain event or queues a passport reading can enqueue.
    wireDomainEvents()
    wirePassportReading()
  }
  catch (error) {
    await closeDb()
    throw error
  }
  const queues = JOBS.filter(job => workTiers.includes(job.tier)).map(job => job.name)
  console.log(`[worker] started (${env.WORKER_JOBS}, polling every ${env.JOBS_POLL_SECONDS}s); queues: ${queues.join(', ') || '(none yet)'}`)

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal}: stopping`)
    await stopJobRuntime()
    await closeDb()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error('[worker] failed to start', error)
  process.exit(1)
})
