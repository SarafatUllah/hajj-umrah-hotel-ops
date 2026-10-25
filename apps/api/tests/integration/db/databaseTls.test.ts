import { readFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createDbWithClient } from '@hajj/db/client'
import { runMigrations } from '@hajj/db/migrations'
import { databaseSsl } from '@hajj/db/ssl'
import { createBoss } from '../../../server/jobs/runtime'

/**
 * Every connection the app opens uses TLS as DATABASE_SSL says (D-P2-67): the app's pool, the migrations and pg-boss.
 * Opt-in (CI has no TLS database): DATABASE_TLS_TEST_URL names a database that accepts TLS connections ONLY (pg_hba
 * `hostssl`), DATABASE_TLS_TEST_CA the file of the CA that signed its certificate. A local one:
 *   openssl CA + a server certificate for 127.0.0.1, then postgres:16 with `-c ssl=on` and a hostssl-only pg_hba.conf.
 */
const url = process.env.DATABASE_TLS_TEST_URL
const caFile = process.env.DATABASE_TLS_TEST_CA

describe.skipIf(!url || !caFile)('database connections over TLS', { timeout: 60_000 }, () => {
  const ca = caFile ? readFileSync(caFile, 'utf8') : ''
  const saved = { DATABASE_SSL: process.env.DATABASE_SSL, DATABASE_SSL_CA: process.env.DATABASE_SSL_CA }

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  async function usesTls(ssl: ReturnType<typeof databaseSsl>): Promise<boolean> {
    const { db, close } = createDbWithClient(url!, { max: 1, ssl })
    try {
      const [row] = await db.execute<{ ssl: boolean }>(sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`)
      return row!.ssl
    }
    finally {
      await close()
    }
  }

  it('a plain connection is refused by the server (so the passes below prove TLS)', async () => {
    await expect(usesTls(databaseSsl({ DATABASE_SSL: 'off' }))).rejects.toThrow()
  })

  it('verify: encrypted, the certificate checked against DATABASE_SSL_CA; without the CA the self-signed chain is refused', async () => {
    expect(await usesTls(databaseSsl({ DATABASE_SSL: 'verify', DATABASE_SSL_CA: ca }))).toBe(true)
    // Drizzle wraps the driver's error ("Failed query: …"); the TLS refusal is its cause.
    const refused = await usesTls(databaseSsl({ DATABASE_SSL: 'verify' })).catch((error: unknown) => error as Error & { cause?: unknown })
    expect(String((refused as { cause?: unknown }).cause)).toMatch(/certificate/i)
  })

  it('require: encrypted without the check', async () => {
    expect(await usesTls(databaseSsl({ DATABASE_SSL: 'require' }))).toBe(true)
  })

  it('the migrations and pg-boss take the same setting from the environment', async () => {
    Object.assign(process.env, { DATABASE_SSL: 'verify', DATABASE_SSL_CA: ca })
    await runMigrations(url!)
    const boss = createBoss({ connectionString: url!, poolMax: 2 }, false)
    await boss.start()
    await boss.stop({ graceful: false, close: true })
    // Reached a TLS-only server: had either connected in clear text, the server would have refused it.
    expect(await usesTls(databaseSsl())).toBe(true)
  })
})
