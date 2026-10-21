/**
 * Base class for every error the API is allowed to translate into an HTTP
 * response with a stable machine-readable `code`. `defineApiHandler`
 * (server/utils/apiHandler.ts) turns any `DomainError` into
 * `createError({ statusCode: httpStatus, statusMessage: message, data: { code, details } })`.
 *
 * Subclasses fix their own `httpStatus` (PF-8) so every call site writes a
 * two-argument (or three-argument, with `details`) constructor call, e.g.
 * `new NotFoundError('HOTEL_NOT_FOUND')` or
 * `new ValidationError('VALIDATION_FAILED', 'Request validation failed', { issues })`.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

/** 422 — the request itself (body/query/params) is invalid. */
export class ValidationError extends DomainError {
  constructor(code: string, message: string = code, details?: unknown) {
    super(code, message, 422, details)
    this.name = 'ValidationError'
  }
}

/** 404 — either the resource does not exist, or the caller has no access to it (indistinguishable, by design). */
export class NotFoundError extends DomainError {
  constructor(code: string, message: string = code, details?: unknown) {
    super(code, message, 404, details)
    this.name = 'NotFoundError'
  }
}

/** 403 — the resource exists and is visible to the caller, but the caller lacks the permission for this action. */
export class ForbiddenError extends DomainError {
  constructor(code: string, message: string = code, details?: unknown) {
    super(code, message, 403, details)
    this.name = 'ForbiddenError'
  }
}

/** 401 — no valid session. */
export class UnauthenticatedError extends DomainError {
  constructor(code: string, message: string = code, details?: unknown) {
    super(code, message, 401, details)
    this.name = 'UnauthenticatedError'
  }
}

/** 409 — the request conflicts with the current state (e.g. a unique or range-overlap violation). */
export class ConflictError extends DomainError {
  constructor(code: string, message: string = code, details?: unknown) {
    super(code, message, 409, details)
    this.name = 'ConflictError'
  }
}
