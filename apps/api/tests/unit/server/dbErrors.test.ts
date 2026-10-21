import { afterEach, describe, expect, it } from 'vitest'
import { ConflictError, ValidationError } from '../../../server/errors/domainError'
import { CONSTRAINT_MESSAGES, extractPgError, translateDbError } from '../../../server/errors/dbErrors'

/** Mirrors Drizzle's own error: no `.code` of its own, the real driver error sits on `.cause`. */
class FakeDrizzleQueryError extends Error {
  constructor(public override cause: unknown) {
    super('Failed query')
  }
}

/** Mirrors the `postgres` driver's PostgresError shape (constructed from the wire-protocol error fields). */
function fakePostgresError(fields: { code: string, constraint_name?: string, table_name?: string, detail?: string }): Error {
  return Object.assign(new Error('db error'), fields)
}

describe('extractPgError', () => {
  it('finds the code on a synthetic DrizzleQueryError wrapping a PostgresError-like cause', () => {
    const wrapped = new FakeDrizzleQueryError(fakePostgresError({ code: '23505', constraint_name: 'organization_slug_unique', table_name: 'organization', detail: 'Key already exists.' }))
    expect(extractPgError(wrapped)).toEqual({ code: '23505', constraint: 'organization_slug_unique', table: 'organization', detail: 'Key already exists.' })
  })

  it('finds the code on a bare Postgres-like error (no wrapping)', () => {
    const bare = fakePostgresError({ code: '23503', constraint_name: 'app_user_organization_id_organization_id_fk' })
    expect(extractPgError(bare)).toEqual({ code: '23503', constraint: 'app_user_organization_id_organization_id_fk', table: undefined, detail: undefined })
  })

  it('returns null for a plain Error', () => {
    expect(extractPgError(new Error('boom'))).toBeNull()
  })

  it('returns null for a non-error value', () => {
    expect(extractPgError('boom')).toBeNull()
    expect(extractPgError(null)).toBeNull()
    expect(extractPgError(undefined)).toBeNull()
  })

  it('stops after depth 4 — a cyclic cause chain never loops forever', () => {
    const cyclic: Error & { cause?: unknown } = new Error('a')
    cyclic.cause = cyclic
    expect(extractPgError(cyclic)).toBeNull()
  })

  it('does not find a code buried deeper than the depth limit', () => {
    const deep = new Error('level1')
    ;(deep as Error & { cause?: unknown }).cause = new Error('level2', { cause: new Error('level3', { cause: new Error('level4', { cause: fakePostgresError({ code: '23505' }) }) }) })
    expect(extractPgError(deep)).toBeNull()
  })
})

describe('translateDbError — generic SQLSTATE mapping', () => {
  it('23505 (unique_violation) -> ConflictError', () => {
    const e = translateDbError(new FakeDrizzleQueryError(fakePostgresError({ code: '23505', constraint_name: 'some_unrelated_unique' })))
    expect(e).toBeInstanceOf(ConflictError)
    expect(e?.code).toBe('ALREADY_EXISTS')
  })

  it('23P01 (exclusion_violation) -> ConflictError', () => {
    const e = translateDbError(fakePostgresError({ code: '23P01' }))
    expect(e).toBeInstanceOf(ConflictError)
    expect(e?.code).toBe('RANGE_OVERLAP')
  })

  it('23503 (foreign_key_violation) -> ValidationError', () => {
    const e = translateDbError(fakePostgresError({ code: '23503' }))
    expect(e).toBeInstanceOf(ValidationError)
    expect(e?.code).toBe('INVALID_REFERENCE')
  })

  it('23514 (check_violation) -> ValidationError', () => {
    const e = translateDbError(fakePostgresError({ code: '23514' }))
    expect(e).toBeInstanceOf(ValidationError)
    expect(e?.code).toBe('CONSTRAINT_VIOLATION')
  })

  it('an unknown SQLSTATE code -> null', () => {
    expect(translateDbError(fakePostgresError({ code: '99999' }))).toBeNull()
  })

  it('55000 (immutable audit) -> null (treated as an internal error, not translated)', () => {
    expect(translateDbError(fakePostgresError({ code: '55000' }))).toBeNull()
  })

  it('a plain Error (not a database error at all) -> null', () => {
    expect(translateDbError(new Error('boom'))).toBeNull()
  })

  it('a known constraint name overrides the generic code/message but keeps the SQLSTATE-implied kind', () => {
    const e = translateDbError(fakePostgresError({ code: '23505', constraint_name: 'organization_slug_unique' }))
    expect(e).toBeInstanceOf(ConflictError)
    expect(e?.code).toBe('ORGANIZATION_SLUG_TAKEN')
  })
})

describe('translateDbError — constraint registry can never override the SQLSTATE-derived kind', () => {
  // A constraint name reserved for this test only, so it can never collide
  // with a real entry — added to the real, exported registry (the one
  // `translateDbError` actually reads) for the duration of a single test,
  // then removed, to prove the production code path itself rejects a
  // mismatch rather than testing a stand-in.
  const MISMATCHED_CONSTRAINT = '__test_only_mismatched_constraint__'

  afterEach(() => {
    Reflect.deleteProperty(CONSTRAINT_MESSAGES, MISMATCHED_CONSTRAINT)
  })

  it('returns null (never a ValidationError) when a CONSTRAINT_MESSAGES entry declares a kind that disagrees with the SQLSTATE-derived kind', () => {
    // 23505 (unique_violation) is generically a 'conflict'. This entry
    // deliberately, incorrectly, declares 'validation' — a config/programmer
    // error the real code must detect and reject, never silently prefer.
    CONSTRAINT_MESSAGES[MISMATCHED_CONSTRAINT] = {
      kind: 'validation',
      code: 'SHOULD_NEVER_BE_RETURNED',
      message: 'should never be returned',
    }

    const e = translateDbError(fakePostgresError({ code: '23505', constraint_name: MISMATCHED_CONSTRAINT }))

    expect(e).toBeNull()
  })
})
