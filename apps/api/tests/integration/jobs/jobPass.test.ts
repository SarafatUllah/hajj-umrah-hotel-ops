import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineJob } from '../../../server/jobs/definition'
import { runJobPass } from '../../../server/jobs/pass'
import { enqueue, startJobRuntime, stopJobRuntime } from '../../../server/jobs/runtime'
import { closeTestDb, getTestDb } from '../support/testDb'
import { requireTestDatabaseUrl } from '../support/testDatabase'

const echoed: number[] = []
const ticked: string[] = []

const echoJob = defineJob<{ n: number }>({ name: 'test.pass-echo', tier: 'light', handle: async (data) => { echoed.push(data.n) } })
const heavyEchoJob = defineJob<{ n: number }>({ name: 'test.pass-heavy-echo', tier: 'heavy', handle: async (data) => { echoed.push(data.n) } })
// Every minute: a cron pass always finds an occurrence in its 60-second window. A name of its own per run: pg-boss sends
// each occurrence once, so a rerun within the same minute would otherwise find this minute's already sent.
const everyMinuteJob = defineJob<Record<string, never>>({ name: `test.pass-every-minute-${randomUUID().slice(0, 8)}`, tier: 'light', schedule: { cron: '* * * * *' }, handle: async (_data, ctx) => { ticked.push(ctx.jobId) } })
const slowJob = defineJob<Record<string, never>>({ name: 'test.pass-slow', tier: 'light', handle: () => new Promise(resolve => setTimeout(resolve, 2_000)) })

const ALL = [echoJob, heavyEchoJob, everyMinuteJob, slowJob] as never
// Each test passes only its own jobs: a schedule exists from the first pass that registers it.
const QUEUED = [echoJob, heavyEchoJob] as never
const pass = (jobs: never, budgetMs: number) => runJobPass({ connectionString: requireTestDatabaseUrl(), db: getTestDb(), jobs, budgetMs })

/**
 * A job pass (D-P2-67): what a serverless host runs on each tick instead of an always-on worker — every queue and
 * every schedule, until nothing is ready or the time budget is spent.
 */
describe('runJobPass', () => {
  beforeAll(async () => {
    // A send-only runtime, as in the serverless API: it enqueues, the pass works.
    await startJobRuntime({ connectionString: requireTestDatabaseUrl(), db: getTestDb(), jobs: ALL, workTiers: [] })
  })

  afterAll(async () => {
    await stopJobRuntime()
    await getTestDb().execute(sql`delete from pgboss.schedule where name like 'test.pass-%'`)
    await closeTestDb()
  })

  it('works every queued job of both tiers, then reports the queues idle', async () => {
    for (const n of [1, 2, 3]) await enqueue(echoJob, { n })
    await enqueue(heavyEchoJob, { n: 4 })
    const result = await pass(QUEUED, 20_000)
    expect([...echoed].sort()).toEqual([1, 2, 3, 4])
    expect(result.idle).toBe(true)
  }, 30_000)

  it('runs a schedule that came due, with the missed-run policy that makes up for the time between passes', async () => {
    const result = await pass([everyMinuteJob] as never, 20_000)
    expect(ticked).toHaveLength(1)
    expect(result.idle).toBe(true)
    const [schedule] = await getTestDb().execute<{ options: { missed?: string } }>(sql`select options from pgboss.schedule where name = ${everyMinuteJob.name}`)
    expect(schedule?.options.missed).toBe('once')
  }, 30_000)

  it('stops at its budget while a job still runs, and says the queues were not idle', async () => {
    await enqueue(slowJob, {})
    const started = Date.now()
    const result = await pass([slowJob] as never, 500)
    expect(result.idle).toBe(false)
    // The stop lets the running job finish (graceful), so the pass ends shortly after it.
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 30_000)
})
