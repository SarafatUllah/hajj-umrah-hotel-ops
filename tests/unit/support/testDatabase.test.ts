import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requireTestDatabaseUrl } from '../../integration/support/testDatabase'

describe('requireTestDatabaseUrl', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL

  beforeEach(() => {
    delete process.env.DATABASE_URL
  })

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = originalDatabaseUrl
  })

  it('accepts a connection string whose database name ends in "_test"', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5433/hajj_umrah_test'
    expect(requireTestDatabaseUrl()).toBe(process.env.DATABASE_URL)
  })

  it('throws for a connection string pointing at the dev database', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5433/hajj_umrah_dev'
    expect(() => requireTestDatabaseUrl()).toThrow(/hajj_umrah_dev/)
  })

  it('throws when DATABASE_URL is missing', () => {
    expect(() => requireTestDatabaseUrl()).toThrow(/DATABASE_URL must be set/)
  })

  it('throws for an unparseable connection string', () => {
    process.env.DATABASE_URL = 'this is not a url'
    expect(() => requireTestDatabaseUrl()).toThrow(/not a parseable connection URL/)
  })

  it('accepts a percent-encoded database name that decodes to a "_test" name', () => {
    // %5F decodes to "_", so this path is "hajj_umrah_test" once decoded.
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5433/hajj_umrah%5Ftest'
    expect(requireTestDatabaseUrl()).toBe(process.env.DATABASE_URL)
  })
})

function listTestFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...listTestFiles(full))
    else if (entry.endsWith('.test.ts')) files.push(full)
  }
  return files
}

describe('integration test hygiene', () => {
  it('contains no hard-coded TRUNCATE statement in any integration test file', () => {
    const integrationDir = join(process.cwd(), 'tests', 'integration')
    const files = listTestFiles(integrationDir)
    expect(files.length).toBeGreaterThan(0)

    const offenders = files.filter(file => readFileSync(file, 'utf-8').includes('TRUNCATE'))
    expect(offenders).toEqual([])
  })
})
