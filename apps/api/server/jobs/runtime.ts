import { PgBoss } from 'pg-boss'
import { databaseSsl } from '@hajj/db/ssl'
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JobRuntimeUnavailableError'
  }
}

/** How long a stop waits for in-flight handlers before abandoning them (below a typical 30 s kill grace). */
export const STOP_TIMEOUT_MS = 20_000

interface Running { boss: PgBoss, registered: ReadonlyMap<string, JobDefinition<never>> }

let running: Promise<Running> | null = null
let lastBootError: unknown = null
/** The options of the runtime this process should have (null when it has none, or once stopped): `enqueue` restarts it. */
let configured: JobRuntimeOptions | null = null

/**
 * Starts the process-wide job runtime once (pg-boss owns its own `pgboss` schema). Every registered
 * queue is created so any process can send to it; handlers are attached only for `workTiers`, and
 * schedules are reconciled by the processes that work them. A failed boot stops what it started and is
 * remembered, so a later `enqueue` reports the real cause — after trying the start once more itself.
 */
export function startJobRuntime(options: JobRuntimeOptions): Promise<Running> {
  configured = options
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

/** The waits between start attempts after a failed boot (the last one repeats). */
const START_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const

/**
 * Starts the runtime and, while that fails (e.g. the API came up before the database), tries again after a growing
 * wait — a process that booted too early still ends up working its jobs instead of running without them until a
 * restart. Returns a function that stops the retrying (Nitro `close`).
 */
export function startJobRuntimeWithRetry(options: JobRuntimeOptions, delaysMs: readonly number[] = START_RETRY_DELAYS_MS): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = (n: number): void => {
    startJobRuntime(options).catch((error: unknown) => {
      if (stopped) return
      const delay = delaysMs[Math.min(n, delaysMs.length - 1)]!
      console.error(`[jobs] runtime failed to start; trying again in ${delay / 1000}s`, error)
      timer = setTimeout(() => attempt(n + 1), delay)
      timer.unref?.()
    })
  }
  const stop = () => {
    stopped = true
    clearTimeout(timer)
  }
  cancelStartRetries = stop
  attempt(0)
  return stop
}

/** Set while startJobRuntimeWithRetry may still try again; stopJobRuntime cancels it. */
let cancelStartRetries: (() => void) | null = null

/** pg-boss's own timing settings (seconds), for a process that needs other than the defaults. */
export type BossTiming = Pick<ConstructorParameters<typeof PgBoss>[0] & object, 'cronMonitorIntervalSeconds' | 'cronWorkerIntervalSeconds'>

/**
 * A pg-boss instance for these options: it supervises, runs schedules and registers itself (pg-boss's instance list,
 * a heartbeat every 30 s) only when it works some tier — a send-only one, such as every serverless API function, writes
 * nothing on its own.
 */
export function createBoss(options: Pick<JobRuntimeOptions, 'connectionString' | 'poolMax'>, working: boolean, timing: BossTiming = {}): PgBoss {
  // TLS as the app's own pool (DATABASE_SSL): pg-boss's pool must not be the one connection left in clear text.
  const boss = new PgBoss({ connectionString: options.connectionString, ssl: databaseSsl(), max: options.poolMax ?? 3, supervise: working, schedule: working, registerInstance: working, ...timing })
  boss.on('error', error => console.error('[jobs]', error))
  return boss
}

/**
 * Every registered queue is created (any process may send to it); for the worked tiers, schedules are reconciled and
 * handlers attached. A schedule makes up for the time no process ran its cron pass (a deploy, a host that only runs
 * passes on a tick) with one run for the latest occurrence it missed (`missed: 'once'`; every job is a sweep).
 */
export async function registerJobs(boss: PgBoss, options: JobRuntimeOptions): Promise<void> {
  for (const job of options.jobs) await boss.createQueue(job.name, job.queue ?? {})
  for (const job of options.jobs) {
    if (!options.workTiers.includes(job.tier)) continue
    // Upsert (several processes may declare the same cron; pg-boss fires it once) — or remove a
    // schedule a definition no longer has.
    if (job.schedule) await boss.schedule(job.name, job.schedule.cron, null, { tz: job.schedule.tz ?? 'UTC', missed: 'once' })
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
}

async function boot(options: JobRuntimeOptions): Promise<Running> {
  const boss = createBoss(options, options.workTiers.length > 0)
  try {
    // Inside the try: a start that fails half-way leaves timers and a pool, which the catch stops (retries would pile them up).
    await boss.start()
    await registerJobs(boss, options)
    return { boss, registered: new Map(options.jobs.map(job => [job.name, job])) }
  }
  catch (error) {
    await boss.stop({ graceful: false, close: true }).catch(() => {})
    throw error
  }
}

/** Stops the runtime (Nitro `close`, worker SIGTERM, test teardown) and any start retries, letting in-flight handlers finish. Idempotent. */
export async function stopJobRuntime(): Promise<void> {
  cancelStartRetries?.()
  cancelStartRetries = null
  configured = null
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
  // A start that failed (a database unreachable on a cold start) is tried again here, not only by the retry timer: on a
  // serverless host that timer waits as long as the instance sleeps, while the requests that need it fail.
  if (!running && configured) startJobRuntime(configured).catch(() => {})
  if (!running) {
    const cause = lastBootError ? `: it failed to start (${String(lastBootError)})` : ' (JOBS_MODE=off?)'
    throw new JobRuntimeUnavailableError(`Job runtime is not running${cause}; cannot enqueue ${job.name}`)
  }
  // A boot still in progress that then fails is the runtime being unavailable, not an error of the caller's change.
  const { boss, registered } = await running.catch((error: unknown) => {
    throw new JobRuntimeUnavailableError(`Job runtime failed to start (${String(error)}); cannot enqueue ${job.name}`, { cause: error })
  })
  if (!registered.has(job.name)) throw new Error(`Job ${job.name} is not registered with the job runtime`)
  const id = await boss.send(job.name, data, {
    ...(options.startAfter !== undefined ? { startAfter: options.startAfter } : {}),
    ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
    ...(options.tx ? { db: pgBossTransactionAdapter(options.tx) } : {}),
  })
  return id
}
