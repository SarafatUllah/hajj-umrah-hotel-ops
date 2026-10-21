import 'dotenv/config'
import { createDbWithClient } from '@hajj/db/client'
import { JOBS } from '../server/jobs'
import { wireDomainEvents } from '../server/jobs/eventJobs'
import { startJobRuntime, stopJobRuntime } from '../server/jobs/runtime'
import { getEnv } from '../server/utils/env'

/**
 * The background worker process (design v7 §2: passport OCR runs in its own process from day one, so a
 * burst of CPU-heavy jobs never slows API requests). It works only the `heavy` tier; light jobs run in
 * the API processes (JOBS_MODE=light). Start with `pnpm --filter @hajj/api worker`.
 */
async function main(): Promise<void> {
  const env = getEnv()
  const { db, close } = createDbWithClient(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX })
  try {
    await startJobRuntime({ connectionString: env.DATABASE_URL, db, jobs: JOBS, workTiers: ['heavy'], poolMax: env.JOBS_POOL_MAX })
    // Heavy jobs may publish domain events too: their handlers' jobs are enqueued from here.
    wireDomainEvents()
  }
  catch (error) {
    await close()
    throw error
  }
  console.log(`[worker] started; heavy queues: ${JOBS.filter(job => job.tier === 'heavy').map(job => job.name).join(', ') || '(none yet)'}`)

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal}: stopping`)
    await stopJobRuntime()
    await close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error('[worker] failed to start', error)
  process.exit(1)
})
