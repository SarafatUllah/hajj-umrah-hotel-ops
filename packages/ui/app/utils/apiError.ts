import { ZodError } from 'zod'

/** One field problem of a 422 (`details.issues`): the path into the request body and the server's message. */
export interface ApiIssue { path: Array<string | number>, message: string }

/**
 * What a failed API call becomes in the frontends: the HTTP status (0 = the server could not be reached), the stable
 * machine-readable `code` (translated client-side, never the raw server text) and its `details`.
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: unknown = null) {
    super(message)
    this.name = 'ApiError'
  }

  /** The 422's field problems (empty for every other error). */
  get issues(): ApiIssue[] {
    const issues = (this.details as { issues?: unknown } | null)?.issues
    return Array.isArray(issues) ? issues as ApiIssue[] : []
  }

  /** A `details` value by name (e.g. `maxPersons`, `bookingNos`), if the server sent one. */
  detail<T = unknown>(name: string): T | undefined {
    return (this.details as Record<string, T> | null)?.[name]
  }
}

interface ErrorBody { statusCode?: number, statusMessage?: string, data?: { code?: string, details?: unknown } }

/**
 * Any thrown value as an `ApiError`: a fetch error carrying the API's standard error body (`statusCode`,
 * `statusMessage`, `data.code`, `data.details`), a fetch that never got an answer (status 0, `NETWORK`), a request a
 * shared schema refused before it was sent (422 `VALIDATION_FAILED`, as the API would answer), or anything else
 * (`UNKNOWN`).
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof ZodError) return new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', { issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) })
  const fetchError = error as { status?: number, statusCode?: number, data?: ErrorBody, response?: unknown, message?: string } | null
  const status = fetchError?.status ?? fetchError?.statusCode
  if (fetchError && typeof status === 'number' && status > 0) {
    const body = fetchError.data ?? {}
    return new ApiError(status, body.data?.code ?? `HTTP_${status}`, body.statusMessage ?? fetchError.message ?? 'Request failed', body.data?.details ?? null)
  }
  if (fetchError && 'response' in fetchError && fetchError.response === undefined) {
    return new ApiError(0, 'NETWORK', fetchError.message ?? 'The server could not be reached')
  }
  return new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : String(error))
}
