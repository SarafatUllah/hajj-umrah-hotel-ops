import 'dotenv/config'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Detects drift between the Drizzle schema and the committed migrations by
 * running `drizzle-kit generate` and checking whether it produced anything
 * new. Unlike a plain `git status` diff, this snapshots the migrations
 * folder (file list + content hashes) *before* running generate and
 * compares it to the folder *after*, so it works correctly even when an
 * uncommitted-but-complete migration is already sitting in the tree (e.g.
 * a later task's WIP): that file is part of the "before" snapshot, not
 * something this run created, so it is left untouched either way.
 *
 * On drift, only the files this run newly created are deleted, and
 * meta/_journal.json (the one pre-existing file `generate` rewrites) is
 * restored from the snapshot. No other pre-existing migration file is ever
 * deleted or modified.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'db/migrations')
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json')

interface Snapshot {
  files: Map<string, string>
  journal: string
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function walk(dir: string, prefix: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, rel, out)
    }
    else {
      out.set(rel, hashFile(full))
    }
  }
}

function snapshot(): Snapshot {
  const files = new Map<string, string>()
  walk(MIGRATIONS_DIR, '', files)
  return { files, journal: readFileSync(JOURNAL_PATH, 'utf8') }
}

function main(): void {
  const before = snapshot()

  try {
    execSync('pnpm exec drizzle-kit generate --name drift_check', { stdio: 'pipe' })
  }
  catch (err) {
    const output = err instanceof Error && 'stdout' in err ? String((err as { stdout: unknown }).stdout) : String(err)
    console.error(output)
    console.error('drizzle-kit generate failed')
    process.exitCode = 1
    return
  }

  const after = snapshot()

  const newFiles = [...after.files.keys()].filter(f => !before.files.has(f))
  const changedFiles = [...after.files.keys()].filter(
    f => before.files.has(f) && before.files.get(f) !== after.files.get(f),
  )
  const hasDrift = newFiles.length > 0 || changedFiles.length > 0

  if (!hasDrift) {
    console.log('No drift: the Drizzle schema matches the committed migrations.')
    return
  }

  for (const relPath of newFiles) {
    unlinkSync(join(MIGRATIONS_DIR, relPath))
  }
  // generate() only ever rewrites the pre-existing journal (to register the
  // migration it just added); restore it so a deleted new migration isn't
  // left dangling as a journal entry.
  writeFileSync(JOURNAL_PATH, before.journal)

  console.error('the Drizzle schema no longer matches the migrations — run `pnpm db:generate`')
  process.exitCode = 1
}

main()
