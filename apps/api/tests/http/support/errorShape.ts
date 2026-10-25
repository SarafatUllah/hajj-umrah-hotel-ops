import { expect } from 'vitest'
import type { ApiResponse } from './client'

/**
 * Enforces the suite-wide invariant (Task 8 proof 10): every non-2xx HTTP response produced
 * anywhere in this suite carries the standard shape `defineApiHandler` renders for a `DomainError`
 * (server/utils/apiHandler.ts) — `statusCode`, `statusMessage`, and `data.code`. Every test in this
 * suite that exercises an error path calls this instead of asserting the shape ad hoc, so the
 * invariant is enforced consistently rather than duplicated per test.
 */
export function expectStandardError(res: ApiResponse, expected?: { status?: number, code?: string }): void {
  expect(res.status).toBeGreaterThanOrEqual(400)
  expect(res.json).toBeTruthy()
  expect(res.json.statusCode).toBe(res.status)
  expect(typeof res.json.statusMessage).toBe('string')
  expect(res.json.statusMessage.length).toBeGreaterThan(0)
  expect(res.json.data).toBeTruthy()
  expect(typeof res.json.data.code).toBe('string')
  expect(res.json.data.code.length).toBeGreaterThan(0)

  if (expected?.status !== undefined) expect(res.status).toBe(expected.status)
  if (expected?.code !== undefined) expect(res.json.data.code).toBe(expected.code)
}
