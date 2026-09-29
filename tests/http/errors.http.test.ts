import { describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'

const baseUrl = inject('httpTestBaseUrl')
const client = apiClient(baseUrl)

describe('GET /api/health (proof 9)', () => {
  it('returns 200 { status: "ok", db: "ok" } when the database is reachable', async () => {
    const res = await client.request('/api/health')

    expect(res.status).toBe(200)
    expect(res.json.status).toBe('ok')
    expect(res.json.db).toBe('ok')
  })
})

describe('Unknown route (proof 9)', () => {
  it('returns 404 in the standard error shape via the catch-all route, for GET', async () => {
    const res = await client.request('/api/this-route-does-not-exist')
    expectStandardError(res, { status: 404, code: 'NOT_FOUND' })
  })

  it('returns 404 in the standard error shape for a non-GET method too', async () => {
    const res = await client.request('/api/this-route-does-not-exist', { method: 'POST', body: { a: 1 } })
    expectStandardError(res, { status: 404, code: 'NOT_FOUND' })
  })
})

describe('Global non-2xx error-shape invariant (proof 10)', () => {
  it('genuinely malformed JSON syntax in a request body never bypasses the standard error wrapper as a raw 500/400', async () => {
    // Below the client.ts abstraction deliberately: apiClient.request() always sends valid JSON
    // (JSON.stringify), so a truly unparseable body needs a raw fetch call here. This is the
    // framework-generated path the brief warns about — Nitro's/h3's own body-parsing failure, not a
    // Zod validation failure (that path is proof 7, already covered in auth.http.test.ts).
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    })
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    }
    catch (error) {
      throw new Error(`expected a JSON error body, got raw text: ${text}`, { cause: error })
    }

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expectStandardError({ status: res.status, json, setCookie: [] })
  })
})
