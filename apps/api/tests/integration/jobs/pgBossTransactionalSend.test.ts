import { PgBoss } from 'pg-boss'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pgBossTransactionAdapter } from '../../../server/jobs/pgBossTransaction'
import { closeTestDb, getTestClient, getTestDb } from '../support/testDb'
import { requireTestDatabaseUrl } from '../support/testDatabase'

/**
 * Spike (design v7 §10, Phase 2a ticket 7): a pg-boss job sent through `pgBossTransactionAdapter(tx)`
 * is written by the CALLER's Drizzle (postgres.js) transaction — it commits with it and disappears with
 * its rollback. Result write-up: docs/spikes/2026-10-21-pg-boss-transactional-send.md.
 */
const QUEUE = 'spike-transactional-send'

class Rollback extends Error {}

describe('pg-boss send inside a Drizzle (postgres.js) transaction', () => {
  let boss: PgBoss

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: requireTestDatabaseUrl(), supervise: false, schedule: false })
    boss.on('error', () => {})
    await boss.start()
    await boss.createQueue(QUEUE)
  })

  afterAll(async () => {
    await boss.deleteQueue(QUEUE)
    await boss.stop({ graceful: false })
    await closeTestDb()
  })

  it('a committed transaction keeps both the domain write and the job (data and startAfter intact)', async () => {
    const startAfter = new Date(Date.now() + 60_000)
    const jobId = await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`select 1`)
      return boss.send(QUEUE, { bookingId: 'b-1', nested: { nights: [1, 2] } }, { startAfter, db: pgBossTransactionAdapter(tx) })
    })
    expect(jobId).toEqual(expect.any(String))
    const job = await boss.getJobById<{ bookingId: string, nested: { nights: number[] } }>(QUEUE, jobId!)
    expect(job?.data).toEqual({ bookingId: 'b-1', nested: { nights: [1, 2] } })
    expect(job?.startAfter.getTime()).toBe(startAfter.getTime())
  })

  it('the job is invisible to other connections until the transaction commits', async () => {
    let seenFromOutside: unknown = 'not-checked'
    const jobId = await getTestDb().transaction(async (tx) => {
      const id = await boss.send(QUEUE, { step: 'pending' }, { db: pgBossTransactionAdapter(tx) })
      seenFromOutside = await boss.getJobById(QUEUE, id!)
      return id
    })
    expect(seenFromOutside).toBeNull()
    expect(await boss.getJobById(QUEUE, jobId!)).not.toBeNull()
  })

  it('a rolled-back transaction leaves no job behind', async () => {
    let jobId: string | null = null
    await expect(getTestDb().transaction(async (tx) => {
      jobId = await boss.send(QUEUE, { step: 'rolled-back' }, { db: pgBossTransactionAdapter(tx) })
      throw new Rollback('abort')
    })).rejects.toBeInstanceOf(Rollback)
    expect(jobId).toEqual(expect.any(String))
    expect(await boss.getJobById(QUEUE, jobId!)).toBeNull()
  })

  it('works on a savepoint (nested Drizzle transaction) and rolls back with it', async () => {
    let inner: string | null = null
    await getTestDb().transaction(async (tx) => {
      await expect(tx.transaction(async (nested) => {
        inner = await boss.send(QUEUE, { step: 'savepoint' }, { db: pgBossTransactionAdapter(nested) })
        throw new Rollback('savepoint')
      })).rejects.toBeInstanceOf(Rollback)
    })
    expect(await boss.getJobById(QUEUE, inner!)).toBeNull()
  })

  it('refuses a handle that is not a Drizzle postgres-js database or transaction', () => {
    expect(() => pgBossTransactionAdapter({} as never)).toThrow(/postgres-js/)
    expect(getTestClient()).toBeDefined()
  })
})
