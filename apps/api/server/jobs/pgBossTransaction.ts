import type postgres from 'postgres'
import type { Db as PgBossDb } from 'pg-boss'
import type { DbOrTx } from '@hajj/db/client'

/**
 * The postgres.js client a Drizzle `postgres-js` database or transaction runs its statements on.
 *
 * Drizzle keeps it at `session.client`: the pool for a `Database`, the `TransactionSql` (or savepoint)
 * for a transaction. That field is not part of Drizzle's public typings, so it is read defensively here
 * and the spike test (tests/integration/jobs/pgBossTransactionalSend.test.ts) pins the behaviour: a
 * Drizzle upgrade that moves it fails that test loudly instead of silently sending outside the
 * transaction.
 */
function postgresClientOf(handle: DbOrTx): postgres.Sql {
  const client = (handle as unknown as { session?: { client?: unknown } }).session?.client
  if (!client || typeof (client as { unsafe?: unknown }).unsafe !== 'function') {
    throw new Error('pgBossTransactionAdapter needs a Drizzle postgres-js database or transaction handle (session.client, verified with drizzle-orm 0.45)')
  }
  return client as postgres.Sql
}

/**
 * A pg-boss `db` adapter that runs pg-boss's SQL on the caller's Drizzle transaction, so a job sent
 * with `{ db: pgBossTransactionAdapter(tx) }` commits with the transaction's own writes and disappears
 * with its rollback (design v7 §10: "pg-boss জব একই transaction-এ"). pg-boss supplies `$n`-parameterised
 * SQL; postgres.js `unsafe(text, values)` binds those parameters the same way `pg` does.
 */
export function pgBossTransactionAdapter(tx: DbOrTx): PgBossDb {
  const client = postgresClientOf(tx)
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const rows = await client.unsafe(text, values as postgres.ParameterOrJSON<never>[])
      return { rows: [...rows] }
    },
  }
}
