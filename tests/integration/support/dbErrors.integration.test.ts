import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { appUser, organization } from '../../../db/schema'
import { ConflictError, ValidationError } from '../../../server/errors/domainError'
import { translateDbError } from '../../../server/errors/dbErrors'
import { closeTestDb, getTestDb, truncateAllTables } from './testDb'

const db = getTestDb()

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

// Pins "Drizzle wraps the driver error, and the SQLSTATE code lives on
// `.cause`, not on the error itself" (A1#8) — both assertions below run
// against a REAL constraint violation raised by Postgres, not a hand-made
// object shaped to look like one.
describe('translateDbError against real Postgres violations', () => {
  it('translates a duplicate organization slug (23505, organization_slug_unique) to a ConflictError', async () => {
    await db.insert(organization).values({ name: 'First', slug: 'dupe-slug-a1-8' })

    let caught: unknown
    try {
      await db.insert(organization).values({ name: 'Second', slug: 'dupe-slug-a1-8' })
    }
    catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    // The caught error is Drizzle's own DrizzleQueryError, which has no
    // `.code` — only its `.cause` (the real Postgres error) does.
    expect((caught as { code?: unknown }).code).toBeUndefined()

    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ConflictError)
    expect(translated?.code).toBe('ORGANIZATION_SLUG_TAKEN')
    expect(translated?.httpStatus).toBe(409)
  })

  it('translates an app_user referencing a non-existent organization (23503, foreign key) to a ValidationError', async () => {
    let caught: unknown
    try {
      await db.insert(appUser).values({
        organizationId: randomUUID(),
        email: 'nobody@example.com',
        passwordHash: 'hash',
        fullName: 'Nobody',
      })
    }
    catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: unknown }).code).toBeUndefined()

    const translated = translateDbError(caught)
    expect(translated).toBeInstanceOf(ValidationError)
    expect(translated?.code).toBe('INVALID_REFERENCE')
    expect(translated?.httpStatus).toBe(422)
  })
})
