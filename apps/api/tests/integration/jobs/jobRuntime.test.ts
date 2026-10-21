import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineJob, workTiersFor } from '../../../server/jobs/definition'
import { enqueue, startJobRuntime, stopJobRuntime } from '../../../server/jobs/runtime'
import { closeTestDb, getTestDb } from '../support/testDb'
import { requireTestDatabaseUrl } from '../support/testDatabase'

const received: Array<{ data: { n: number }, jobId: string }> = []
let notify: (() => void) | null = null

const lightJob = defineJob<{ n: number }>({
  name: 'test.light-echo',
  tier: 'light',
  handle: async (data, ctx) => {
    received.push({ data, jobId: ctx.jobId })
    notify?.()
  },
})
const heavyJob = defineJob<{ n: number }>({ name: 'test.heavy-never', tier: 'heavy', handle: async () => { throw new Error('heavy job must not run in a light process') } })
const unregistered = defineJob<{ n: number }>({ name: 'test.unregistered', tier: 'light', handle: async () => {} })

const waitForJob = () => new Promise<void>((resolve) => { notify = resolve })

describe('job runtime (light tier, transactional enqueue)', () => {
  beforeAll(async () => {
    await startJobRuntime({ connectionString: requireTestDatabaseUrl(), db: getTestDb(), jobs: [lightJob, heavyJob] as never, workTiers: ['light'], pollingIntervalSeconds: 0.5 })
  })

  afterAll(async () => {
    await stopJobRuntime()
    await closeTestDb()
  })

  it('maps JOBS_MODE to the tiers a process works', () => {
    expect(workTiersFor('off')).toBeNull()
    expect(workTiersFor('send')).toEqual([])
    expect(workTiersFor('light')).toEqual(['light'])
    expect(workTiersFor('all')).toEqual(['light', 'heavy'])
  })

  it('delivers a job enqueued in a committed transaction, with its id as the idempotency key', async () => {
    const delivered = waitForJob()
    const id = await getTestDb().transaction(tx => enqueue(lightJob, { n: 7 }, { tx }))
    await delivered
    expect(received.at(-1)).toEqual({ data: { n: 7 }, jobId: id })
  }, 20_000)

  it('refuses to enqueue a job that is not registered', async () => {
    await expect(enqueue(unregistered, { n: 1 })).rejects.toThrow(/not registered/)
  })

  it('refuses to enqueue once the runtime is stopped', async () => {
    await stopJobRuntime()
    await expect(enqueue(lightJob, { n: 1 })).rejects.toThrow(/not running/)
  })
})

describe('job runtime boot failure and singletons', () => {
  afterAll(async () => {
    await stopJobRuntime()
    await closeTestDb()
  })

  it('a failed boot stops what it started and makes enqueue report the cause', async () => {
    const badCron = defineJob<{ n: number }>({ name: 'test.bad-cron', tier: 'light', schedule: { cron: 'not a cron' }, handle: async () => {} })
    await expect(startJobRuntime({ connectionString: requireTestDatabaseUrl(), db: getTestDb(), jobs: [badCron] as never, workTiers: ['light'] })).rejects.toThrow()
    await expect(enqueue(badCron, { n: 1 })).rejects.toThrow(/failed to start/)
  })

  it('a duplicate singleton send returns null instead of throwing', async () => {
    const single = defineJob<{ n: number }>({ name: `test.singleton-short-${Date.now()}`, tier: 'light', queue: { policy: 'short' }, handle: async () => {} })
    await startJobRuntime({ connectionString: requireTestDatabaseUrl(), db: getTestDb(), jobs: [single] as never, workTiers: [] })
    const first = await enqueue(single, { n: 1 }, { singletonKey: 'only-one', startAfter: Date.now() + 60_000 })
    const second = await enqueue(single, { n: 2 }, { singletonKey: 'only-one', startAfter: Date.now() + 60_000 })
    expect(first).toEqual(expect.any(String))
    expect(second).toBeNull()
  })
})
