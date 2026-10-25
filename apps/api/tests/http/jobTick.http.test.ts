import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { apiClient } from './support/client'
import { expectStandardError } from './support/errorShape'
import { startExtraServer, type ExtraServer } from './support/spawnServer'

const SECRET = 'tick-secret-for-the-http-tests-0123456789'
const shared = apiClient(inject('httpTestBaseUrl'))
let tickServer: ExtraServer | undefined
let ticking: ReturnType<typeof apiClient>

beforeAll(async () => {
  // A host without an always-on worker: the API only enqueues, a scheduler calls the tick (D-P2-67).
  tickServer = await startExtraServer({ JOBS_MODE: 'send', JOBS_TICK_SECRET: SECRET })
  ticking = apiClient(tickServer.baseUrl)
}, 60_000)

afterAll(async () => {
  await tickServer?.stop()
})

describe('POST /api/jobs/tick', () => {
  it('without JOBS_TICK_SECRET configured: 404 like an unknown route, whatever the caller sends', async () => {
    expectStandardError(await shared.request('/api/jobs/tick', { method: 'POST' }), { status: 404, code: 'NOT_FOUND' })
    expectStandardError(await shared.request('/api/jobs/tick', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }), { status: 404, code: 'NOT_FOUND' })
  })

  it('refuses a missing or wrong bearer token with 401, before any job runs', async () => {
    expectStandardError(await ticking.request('/api/jobs/tick', { method: 'POST' }), { status: 401, code: 'UNAUTHENTICATED' })
    expectStandardError(await ticking.request('/api/jobs/tick', { method: 'POST', headers: { authorization: 'Bearer wrong' } }), { status: 401, code: 'UNAUTHENTICATED' })
  })

  it('runs a job pass for the right token and reports it', async () => {
    const res = await ticking.request('/api/jobs/tick', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json).toMatchObject({ idle: true })
    expect(typeof (res.json as { durationMs: unknown }).durationMs).toBe('number')
    expect(res.headers.get('cache-control')).toContain('no-store')
  }, 60_000)
})
