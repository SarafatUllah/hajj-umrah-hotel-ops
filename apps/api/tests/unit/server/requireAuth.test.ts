import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthenticatedError } from '../../../server/errors/domainError'

vi.mock('../../../server/utils/db', () => ({ useDb: () => 'fake-db' }))

const resolveAuthContextMock = vi.fn()
vi.mock('../../../server/security/authContext', () => ({
  resolveAuthContext: (...args: unknown[]) => resolveAuthContextMock(...args),
}))

const { requireAuthContext } = await import('../../../server/utils/requireAuth')

function makeEvent(): H3Event {
  return { context: {} } as H3Event
}

const SESSION_USER = { id: 'user-1', organizationId: 'org-1', email: 'a@b.com', fullName: 'A B' }

describe('requireAuthContext', () => {
  let requireUserSessionMock: ReturnType<typeof vi.fn>
  let clearUserSessionMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resolveAuthContextMock.mockReset()
    requireUserSessionMock = vi.fn(async () => ({ user: SESSION_USER }))
    clearUserSessionMock = vi.fn(async () => {})
    vi.stubGlobal('requireUserSession', requireUserSessionMock)
    vi.stubGlobal('clearUserSession', clearUserSessionMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('memoizes: two calls on the same event resolve the auth context only once', async () => {
    const fakeCtx = { identity: SESSION_USER, authz: { permissions: new Set(), allHotels: false, hotelIds: new Set() }, scope: {}, db: 'fake-db', now: () => new Date() }
    resolveAuthContextMock.mockResolvedValue(fakeCtx)
    const event = makeEvent()

    const first = await requireAuthContext(event)
    const second = await requireAuthContext(event)

    expect(first).toBe(fakeCtx)
    expect(second).toBe(fakeCtx)
    expect(resolveAuthContextMock).toHaveBeenCalledTimes(1)
    expect(requireUserSessionMock).toHaveBeenCalledTimes(1)
  })

  it('memoizes concurrent calls too: two calls started before either resolves still hit the resolver once', async () => {
    const fakeCtx = { identity: SESSION_USER, authz: { permissions: new Set(), allHotels: false, hotelIds: new Set() }, scope: {}, db: 'fake-db', now: () => new Date() }
    resolveAuthContextMock.mockResolvedValue(fakeCtx)
    const event = makeEvent()

    const [first, second] = await Promise.all([requireAuthContext(event), requireAuthContext(event)])

    expect(first).toBe(fakeCtx)
    expect(second).toBe(fakeCtx)
    expect(resolveAuthContextMock).toHaveBeenCalledTimes(1)
  })

  it('clears the session and throws UnauthenticatedError(SESSION_INVALID) when resolution returns null', async () => {
    resolveAuthContextMock.mockResolvedValue(null)
    const event = makeEvent()

    await expect(requireAuthContext(event)).rejects.toBeInstanceOf(UnauthenticatedError)
    await expect(requireAuthContext(event).catch(e => e.code)).resolves.toBe('SESSION_INVALID')
    expect(clearUserSessionMock).toHaveBeenCalled()
  })

  it('passes only the bare identity tuple (userId, organizationId) from the session to resolveAuthContext', async () => {
    resolveAuthContextMock.mockResolvedValue({ identity: SESSION_USER, authz: { permissions: new Set(), allHotels: false, hotelIds: new Set() }, scope: {}, db: 'fake-db', now: () => new Date() })
    await requireAuthContext(makeEvent())

    expect(resolveAuthContextMock).toHaveBeenCalledWith('fake-db', { userId: 'user-1', organizationId: 'org-1' })
  })
})
