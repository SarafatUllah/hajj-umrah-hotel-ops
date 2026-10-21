import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '../../../server/errors/domainError'

describe('DomainError subclasses', () => {
  it('ValidationError carries code, message and status 422', () => {
    const e = new ValidationError('BAD_INPUT', 'Bad input', { field: 'x' })
    expect(e).toBeInstanceOf(DomainError)
    expect(e.code).toBe('BAD_INPUT')
    expect(e.message).toBe('Bad input')
    expect(e.httpStatus).toBe(422)
    expect(e.details).toEqual({ field: 'x' })
  })

  it('NotFoundError carries status 404', () => {
    const e = new NotFoundError('HOTEL_NOT_FOUND')
    expect(e.code).toBe('HOTEL_NOT_FOUND')
    expect(e.httpStatus).toBe(404)
  })

  it('ForbiddenError carries status 403', () => {
    expect(new ForbiddenError('NO_PERMISSION').httpStatus).toBe(403)
  })

  it('UnauthenticatedError carries status 401', () => {
    expect(new UnauthenticatedError('NO_SESSION').httpStatus).toBe(401)
  })

  it('ConflictError carries status 409', () => {
    expect(new ConflictError('ALREADY_EXISTS').httpStatus).toBe(409)
  })

  it('defaults message to code when no message is given (PF-8)', () => {
    const e = new NotFoundError('ROOM_NOT_FOUND')
    expect(e.message).toBe('ROOM_NOT_FOUND')
  })

  it('a ValidationError built from a Zod failure exposes issues with path + message only', () => {
    const schema = z.object({ email: z.string().email(), password: z.string() })
    const result = schema.safeParse({ email: 'not-an-email', password: 'secret-value' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')

    const issues = result.error.issues.map(issue => ({ path: issue.path, message: issue.message }))
    const e = new ValidationError('VALIDATION_FAILED', 'Request validation failed', { issues })

    expect(e.httpStatus).toBe(422)
    expect(e.details).toEqual({ issues: [{ path: ['email'], message: expect.any(String) }] })
    // Never echoes the raw (potentially secret) input value.
    expect(JSON.stringify(e.details)).not.toContain('secret-value')
  })
})
