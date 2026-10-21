import { PgBoss } from 'pg-boss'
import type { Database, DbOrTx } from '@hajj/db/client'
import type { JobDefinition, JobTier } from './definition'
import { pgBossTransactionAdapter } from './pgBossTransaction'

export interface JobRuntimeOptions {
  connectionString: string
  db: Database
  jobs: readonly JobDefinition<never>[]
  /** Tiers this process works. Empty = send-only (queues are created, nothing is consumed). */
  workTiers: readonly JobTier[]
  /** Size of pg-boss's own `pg` pool (separate from the application pool). */
  poolMax?: number
  /** Worker polling interval; tests use a short one. */
  pollingIntervalSeconds?: number
}

export interface EnqueueOptions {
  /** Send inside this transaction: the job commits or rolls back with it. */
  tx?: DbOrTx
  startAfter?: Date | number
  /**
   * Deduplication key. Only honoured by queues whose policy dedupes (`short`, `singleton`, `stately`
   * — set it in the job definition's `queue.policy`); a rejected duplicate returns `null`.
   */
  singletonKey?: string
}

/** The job runtime is not running in this process (not started, failed to start, or stopping). */
export class JobRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobRuntimeUnavailableError'
  }
}

/** How long a stop waits for in-flight handlers before abandoning them (below a typical 30 s kill grace). */
const STOP_TIMEOUT_MS = 20_000

interface Running { boss: PgBoss, registered: ReadonlyMap<string, JobDefinition<never>> }

let running: Promise<Running> | null = null
let lastBootError: unknown = null

/**
 * Starts the process-wide job runtime once (pg-boss owns its own `pgboss` schema). Every registered
 * queue is created so any process can send to it; handlers are attached only for `workTiers`, and
 * schedules are reconciled by the processes that work them. A failed boot stops what it started and is
 * remembered, so a later `enqueue` reports the real cause.
 */
export function startJobRuntime(options: JobRuntimeOptions): Promise<Running> {
  running ??= boot(options).then((value) => {
    lastBootError = null
    return value
  }, (error: unknown) => {
    running = null
    lastBootError = error
    throw error
  })
  return running
}

async function boot(options: JobRuntimeOptions): Promise<Running> {
  const working = options.workTiers.length > 0
  const boss = new PgBoss({ connectionString: options.connectionString, max: options.poolMax ?? 3, supervise: working, schedule: working })
  boss.on('error', error => console.error('[jobs]', error))
  await boss.start()
  try {
    for (const job of options.jobs) await boss.createQueue(job.name, job.queue ?? {})
    for (const job of options.jobs) {
      if (!options.workTiers.includes(job.tier)) continue
      // Upsert (several processes may declare the same cron; pg-boss fires it once) — or remove a
      // schedule a definition no longer has.
      if (job.schedule) await boss.schedule(job.name, job.schedule.cron, null, { tz: job.schedule.tz ?? 'UTC' })
      else await boss.unschedule(job.name)
      await boss.work<object>(job.name, { batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 }, async ([item]) => {
        if (!item) return
        try {
          await job.handle(item.data as never, { db: options.db, jobId: item.id })
        }
        catch (error) {
          console.error(`[jobs] ${job.name} ${item.id} failed`, error)
          throw error // pg-boss records the failure and applies the queue's retry policy
        }
      })
    }
    return { boss, registered: new Map(options.jobs.map(job => [job.name, job])) }
  }
  catch (error) {
    await boss.stop({ graceful: false, close: true }).catch(() => {})
    throw error
  }
}

/** Stops the runtime (Nitro `close`, worker SIGTERM, test teardown), letting in-flight handlers finish. Idempotent. */
export async function stopJobRuntime(): Promise<void> {
  if (!running) return
  const current = running
  running = null
  const runtime = await current.catch(() => null)
  await runtime?.boss.stop({ graceful: true, close: true, timeout: STOP_TIMEOUT_MS })
}

/**
 * Sends `data` to `job`'s queue and returns the job id (`null` only when the queue policy rejected a duplicate).
 * With `tx`, the job is written by that transaction (see pgBossTransactionAdapter) — the outbox
 * guarantee: no committed change without its job, no job without its committed change.
 */
export async function enqueue<T extends object>(job: JobDefinition<T>, data: T, options: EnqueueOptions = {}): Promise<string | null> {
  if (!running) {
    const cause = lastBootError ? `: it failed to start (${String(lastBootError)})` : ' (JOBS_MODE=off?)'
    throw new JobRuntimeUnavailableError(`Job runtime is not running${cause}; cannot enqueue ${job.name}`)
  }
  const { boss, registered } = await running
  if (!registered.has(job.name)) throw new Error(`Job ${job.name} is not registered with the job runtime`)
  const id = await boss.send(job.name, data, {
    ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
    ...(options.tx ? { db: pgBossTransactionAdapter(options.tx) } : {}),
  })
  return id
}
