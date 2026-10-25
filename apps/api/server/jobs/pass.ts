import { sql } from 'drizzle-orm'
import type { Database } from '@hajj/db/client'
import type { JobTier } from './definition'
import { createBoss, registerJobs, STOP_TIMEOUT_MS, type JobRuntimeOptions } from './runtime'

export interface JobPassOptions extends Omit<JobRuntimeOptions, 'workTiers' | 'pollingIntervalSeconds'> {
  /** The longest the pass keeps working before it stops (the jobs still running are let finish). */
  budgetMs: number
}

export interface JobPassResult {
  /** Nothing was ready or running when the pass stopped (false: it ran out of budget first). */
  idle: boolean
  durationMs: number
}

const ALL_TIERS: readonly JobTier[] = ['light', 'heavy']
/** How often the pass polls its queues, and looks whether they are idle: the shortest pg-boss allows is 0.5 s. */
const PASS_POLL_SECONDS = 0.5
const IDLE_CHECK_MS = 1_000
/**
 * The cron pass claims its turn for this long, and due schedules are forwarded to their queues this often: the
 * shortest pg-boss allows, so a pass runs its cron pass even right after another (two never send one occurrence
 * twice: pg-boss files each under one key) and sees the forwarded jobs within its budget.
 */
const PASS_TIMING = { cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1 }
/**
 * No pass calls itself idle sooner: the cron pass that runs as the instance starts comes before the schedules are
 * (re)registered, so a schedule seen for the first time is sent by the next one (a second later) and forwarded by the
 * send-it worker (a second after that) — an empty look before then would end the pass before its jobs exist.
 */
const MIN_PASS_MS = 3_000
/** pg-boss names its internal queues (the one that turns due schedules into jobs among them) with this prefix. */
const PG_BOSS_QUEUE_PREFIX = '__pgboss__'

/**
 * Jobs ready to run now (not waiting out a retry delay) or running, in `queues` and pg-boss's own queues. Counted
 * live from pg-boss's job table: its queue statistics are a cache its monitor refreshes, too stale for this.
 */
async function busyJobs(db: Database, queues: readonly string[]): Promise<number> {
  const names = sql`array[${sql.join(queues.map(name => sql`${name}`), sql`, `)}]::text[]`
  const [row] = await db.execute<{ busy: number }>(sql`
    select count(*)::int as busy from pgboss.job
    where (name = any(${names}) or starts_with(name, ${PG_BOSS_QUEUE_PREFIX}))
      and (state = 'active' or (state in ('created', 'retry') and start_after <= now()))`)
  return row?.busy ?? 0
}

/**
 * One job pass (D-P2-67): what a host without an always-on worker runs on each tick (`POST /api/jobs/tick`, called by
 * a scheduler). Its own pg-boss instance works every tier and runs the cron pass once (schedules make up for the time
 * since the last tick: `missed: 'once'`), until no queue has a job ready or running, or the budget is spent. Deferred
 * jobs (retries waiting out their backoff) are left for a later pass.
 */
export async function runJobPass(options: JobPassOptions): Promise<JobPassResult> {
  const started = Date.now()
  const boss = createBoss(options, true, PASS_TIMING)
  const queues = options.jobs.map(job => job.name)
  let idle = false
  try {
    await boss.start()
    await registerJobs(boss, { ...options, workTiers: ALL_TIERS, pollingIntervalSeconds: PASS_POLL_SECONDS })
    // The cron pass starts with the instance; the first look comes after it has had time to send what is due.
    while (!idle && Date.now() - started < options.budgetMs) {
      await new Promise(resolve => setTimeout(resolve, IDLE_CHECK_MS))
      // pg-boss's own queues too: a due schedule is a job in its send-it queue before it is one in ours.
      idle = Date.now() - started >= MIN_PASS_MS && (await busyJobs(options.db, queues)) === 0
    }
    return { idle, durationMs: Date.now() - started }
  }
  finally {
    await boss.stop({ graceful: true, close: true, timeout: STOP_TIMEOUT_MS })
  }
}
