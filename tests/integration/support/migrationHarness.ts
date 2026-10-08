import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { requireTestDatabaseUrl } from './testDatabase'

const MIGRATIONS_DIR = join(process.cwd(), 'db/migrations')

interface Journal {
  entries: Array<{ idx: number }>
}

/**
 * Creates a throwaway database called `name` on the same server as the
 * integration test database, runs `fn` with its connection URL, and drops it
 * afterwards (also when `fn` throws). A leftover database of the same name
 * from an aborted run is dropped first. The name must end in `_test` so the
 * scratch database can never be confused with a real one.
 */
export async function withScratchDatabase<T>(name: string, fn: (url: string) => Promise<T>): Promise<T> {
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Scratch database name "${name}" must match /^[a-z0-9_]+_test$/`)
  }

  const baseUrl = requireTestDatabaseUrl()
  const scratchUrl = new URL(baseUrl)
  scratchUrl.pathname = `/${name}`

  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    try {
      return await fn(scratchUrl.toString())
    }
    finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    }
  }
  finally {
    await admin.end()
  }
}

async function runMigrations(url: string, migrationsFolder: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(client), { migrationsFolder })
  }
  finally {
    await client.end()
  }
}

/**
 * Applies the committed migrations up to and including journal index
 * `lastIdx`, leaving later ones pending. Works on a temporary copy of
 * db/migrations whose meta/_journal.json is truncated, so the real folder is
 * never touched.
 */
export async function migrateThrough(url: string, lastIdx: number): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'hajj-umrah-migrations-'))
  try {
    await cp(MIGRATIONS_DIR, dir, { recursive: true })
    const journalPath = join(dir, 'meta', '_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal
    journal.entries = journal.entries.filter(entry => entry.idx <= lastIdx)
    await writeFile(journalPath, JSON.stringify(journal, null, 2))
    await runMigrations(url, dir)
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Applies every migration still pending. Drizzle skips migrations whose
 * timestamp is not newer than the last one recorded, so this also completes
 * a database that `migrateThrough` left partially migrated.
 */
export async function migrateAll(url: string): Promise<void> {
  await runMigrations(url, MIGRATIONS_DIR)
}
