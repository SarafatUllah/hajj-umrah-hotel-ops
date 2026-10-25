import type { Queue } from 'pg-boss'
import type { Database } from '@hajj/db/client'

/**
 * Where a job may run. `light` jobs (hold sweep, reminders, retention) may run inside the API process;
 * `heavy` jobs (passport OCR) are CPU-bound and only ever run in the separate worker process, so a
 * burst of them can never slow API requests (design v7 §2, §13).
 */
export type JobTier = 'light' | 'heavy'

export interface JobContext {
  /** The application pool (not a transaction): a handler opens its own transaction when it needs one. */
  db: Database
  /** pg-boss job id — the idempotency key for handlers with side effects (Phase 2a ticket 7). */
  jobId: string
}

export interface JobDefinition<T extends object = object> {
  /** Queue name; stable, kebab-case, namespaced by module (`booking.hold-sweep`). */
  readonly name: string
  readonly tier: JobTier
  /** Retry/expiry/dedupe policy for the queue (pg-boss queue options), applied when the queue is first created. */
  readonly queue?: Omit<Queue, 'name'>
  /** Recurring trigger (cron, evaluated in UTC unless `tz` is given). */
  readonly schedule?: { cron: string, tz?: string }
  readonly handle: (data: T, ctx: JobContext) => Promise<void>
}

/** Identity function that fixes the payload type of a job definition. */
export function defineJob<T extends object>(definition: JobDefinition<T>): JobDefinition<T> {
  return definition
}

export type JobsMode = 'off' | 'send' | 'light' | 'all'
export type WorkerJobs = 'heavy' | 'all'

/** The tiers a process works for a `JOBS_MODE` (`null` = no runtime at all). */
export function workTiersFor(mode: JobsMode): readonly JobTier[] | null {
  switch (mode) {
    case 'off': return null
    case 'send': return []
    case 'light': return ['light']
    case 'all': return ['light', 'heavy']
  }
}

/** The tiers the worker process works for a `WORKER_JOBS` (`all` when the API processes only enqueue). */
export function workerTiersFor(jobs: WorkerJobs): readonly JobTier[] {
  return jobs === 'all' ? ['light', 'heavy'] : ['heavy']
}
