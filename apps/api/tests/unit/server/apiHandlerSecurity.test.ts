import type { H3Event } from 'h3'
import { createEvent, isError } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooManyRequestsError } from '../../../server/errors/domainError'

const requireAuthContextMock = vi.fn()
vi.mock('../../../server/utils/requireAuth', () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}))

const requireAgencyContextMock = vi.fn()
vi.mock('../../../server/utils/requireAgency', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/utils/requireAgency')>()),
  requireAgencyContext: (...args: unknown[]) => requireAgencyContextMock(...args),
}))

const { defineApiHandler } = await import('../../../server/utils/apiHandler')

function makeEvent(): { event: H3Event, headers: Map<string, unknown> } {
  const headers = new Map<string, unknown>()
  const req = { method: 'GET', url: '/', headers: {} }
  const res = { statusCode: 200, headersSent: false, writableEnded: false, setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value), end: () => {} }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a minimal Node req/res stand-in, not a real IncomingMessage/ServerResponse.
  return { event: createEvent(req as any, res as any), headers }
}

async function capture(promise: Promise<unknown>): Promise<{ statusCode: number, data: { code: string, details?: unknown } }> {
  const error = await promise.catch((e: unknown) => e)
  if (!isError(error)) throw new Error('expected an H3Error')
  return error as unknown as { statusCode: number, data: { code: string, details?: unknown } }
}

describe('defineApiHandler: 429 Too Many Requests', () => {
  it('answers 429 with the code, the retry delay in details and a Retry-After header', async () => {
    const handler = defineApiHandler({ handler: async () => { throw new TooManyRequestsError('TOO_MANY_REQUESTS', 42) } })
    const { event, headers } = makeEvent()

    const error = await capture(handler(event))

    expect(error.statusCode).toBe(429)
    expect(error.data).toEqual({ code: 'TOO_MANY_REQUESTS', details: { retryAfterSeconds: 42 } })
    expect(headers.get('retry-after')).toBe(42)
  })
})

describe('defineApiHandler: two-factor enrollment gate', () => {
  beforeEach(() => {
    requireAuthContextMock.mockReset()
  })

  it('answers 403 TWO_FACTOR_ENROLLMENT_REQUIRED to a user who must enrol first, without running the handler', async () => {
    requireAuthContextMock.mockResolvedValue({ twoFactorEnrollmentPending: true })
    const inner = vi.fn(async () => 'ran')
    const handler = defineApiHandler({ auth: 'required', handler: inner })

    const error = await capture(handler(makeEvent().event))

    expect(error.statusCode).toBe(403)
    expect(error.data.code).toBe('TWO_FACTOR_ENROLLMENT_REQUIRED')
    expect(inner).not.toHaveBeenCalled()
  })

  it('lets that user reach a route that allows pending enrollment (auth/me, 2FA setup)', async () => {
    requireAuthContextMock.mockResolvedValue({ twoFactorEnrollmentPending: true })
    const handler = defineApiHandler({ auth: 'required', allowTwoFactorEnrollmentPending: true, handler: async () => 'ran' })

    await expect(handler(makeEvent().event)).resolves.toBe('ran')
  })

  it('runs the handler for a user without a pending enrollment', async () => {
    requireAuthContextMock.mockResolvedValue({ twoFactorEnrollmentPending: false })
    const handler = defineApiHandler({ auth: 'required', handler: async () => 'ran' })

    await expect(handler(makeEvent().event)).resolves.toBe('ran')
  })
})

describe('defineApiHandler: agency routes require an APPROVED agency by default', () => {
  beforeEach(() => {
    requireAgencyContextMock.mockReset()
  })

  it.each(['PENDING', 'SUSPENDED', 'REJECTED'])('auth: agency answers a %s agency 403 AGENCY_NOT_APPROVED without running the handler', async (status) => {
    requireAgencyContextMock.mockResolvedValue({ agency: { id: 'a', name: 'A', status } })
    const inner = vi.fn(async () => 'ran')

    const error = await capture(defineApiHandler({ auth: 'agency', handler: inner })(makeEvent().event))

    expect(error.statusCode).toBe(403)
    expect(error.data.code).toBe('AGENCY_NOT_APPROVED')
    expect(inner).not.toHaveBeenCalled()
  })

  it('auth: agency runs for an APPROVED agency; agency-any-status runs for any status', async () => {
    requireAgencyContextMock.mockResolvedValue({ agency: { id: 'a', name: 'A', status: 'APPROVED' } })
    await expect(defineApiHandler({ auth: 'agency', handler: async () => 'ran' })(makeEvent().event)).resolves.toBe('ran')
    requireAgencyContextMock.mockResolvedValue({ agency: { id: 'a', name: 'A', status: 'PENDING' } })
    await expect(defineApiHandler({ auth: 'agency-any-status', handler: async () => 'ran' })(makeEvent().event)).resolves.toBe('ran')
  })
})
