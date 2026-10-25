import { afterEach, describe, expect, it, vi } from 'vitest'

/** A stand-in pg-boss: its first `failuresLeft` starts fail (a database unreachable on a cold start), then it works. */
const boss = vi.hoisted(() => ({ failuresLeft: 0, configs: [] as Array<Record<string, unknown>>, sent: [] as string[] }))
vi.mock('pg-boss', () => ({
  PgBoss: class {
    constructor(config: Record<string, unknown>) {
      boss.configs.push(config)
    }

    on() {}
    async start() {
      if (boss.failuresLeft > 0) {
        boss.failuresLeft -= 1
        throw new Error('connect ECONNREFUSED')
      }
    }

    async createQueue() {}
    async schedule() {}
    async unschedule() {}
    async work() {}
    async send(name: string) {
      boss.sent.push(name)
      return 'job-1'
    }

    async stop() {}
  },
}))

const { createBoss, enqueue, startJobRuntime, stopJobRuntime } = await import('../../../server/jobs/runtime')
const { defineJob } = await import('../../../server/jobs/definition')

const job = defineJob<{ n: number }>({ name: 'test.send-only', tier: 'light', handle: async () => {} })
const sendOnly = { connectionString: 'postgres://unused', db: {} as never, jobs: [job] as never, workTiers: [] }

describe('job runtime start (send-only processes such as serverless API functions)', () => {
  afterEach(async () => {
    await stopJobRuntime()
    Object.assign(boss, { failuresLeft: 0, configs: [], sent: [] })
  })

  it('a runtime whose start failed starts again on the next enqueue instead of refusing until a retry timer fires', async () => {
    boss.failuresLeft = 1
    await expect(startJobRuntime(sendOnly)).rejects.toThrow('ECONNREFUSED')
    expect(await enqueue(job, { n: 1 })).toBe('job-1')
    expect(boss.sent).toEqual(['test.send-only'])
    expect(boss.configs).toHaveLength(2)
  })

  it('an enqueue whose new start fails too reports that failure', async () => {
    boss.failuresLeft = 2
    await expect(startJobRuntime(sendOnly)).rejects.toThrow('ECONNREFUSED')
    await expect(enqueue(job, { n: 1 })).rejects.toThrow(/failed to start.*ECONNREFUSED/)
  })

  it('a stopped runtime is not started again by an enqueue (a shutdown stays a shutdown)', async () => {
    await startJobRuntime(sendOnly)
    await stopJobRuntime()
    await expect(enqueue(job, { n: 1 })).rejects.toThrow(/not running/)
    expect(boss.configs).toHaveLength(1)
  })

  it('only a process that works jobs registers itself with pg-boss (a send-only one writes no heartbeat every 30 s)', () => {
    createBoss(sendOnly, false)
    createBoss(sendOnly, true)
    expect(boss.configs.map(config => config.registerInstance)).toEqual([false, true])
  })
})
