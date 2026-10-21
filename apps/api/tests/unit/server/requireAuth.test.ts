import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnauthenticatedError } from '../../../server/errors/domainError'

vi.mock('../../../server/utils/db', () => ({ useDb: () => 'fake-db' }))

const envState = { STAFF_2FA_ENFORCEMENT: 'off' as 'off' | 'required-roles' }
vi.mock('../../../server/utils/env', () => ({ getEnv: () => envState }))

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
    envState.STAFF_2FA_ENFORCEMENT = 'off'
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

  it('passes only the bare identity tuple (userId, organizationId, sessionVersion — 1 when absent) from the session to resolveAuthContext', async () => {
    resolveAuthContextMock.mockResolvedValue({ identity: SESSION_USER, authz: { permissions: new Set(), allHotels: false, hotelIds: new Set() }, scope: {}, db: 'fake-db', now: () => new Date() })
    await requireAuthContext(makeEvent())

    expect(resolveAuthContextMock).toHaveBeenCalledWith('fake-db', { userId: 'user-1', organizationId: 'org-1', sessionVersion: 1 }, undefined, { enforceTwoFactor: false })
  })

  it('passes the session version the session carries', async () => {
    resolveAuthContextMock.mockResolvedValue({ identity: SESSION_USER })
    requireUserSessionMock.mockResolvedValueOnce({ user: { ...SESSION_USER, kind: 'staff', sessionVersion: 4 } })
    await requireAuthContext(makeEvent())

    expect(resolveAuthContextMock).toHaveBeenCalledWith('fake-db', { userId: 'user-1', organizationId: 'org-1', sessionVersion: 4 }, undefined, { enforceTwoFactor: false })
  })

  it('asks for the two-factor enrollment check only when STAFF_2FA_ENFORCEMENT=required-roles', async () => {
    envState.STAFF_2FA_ENFORCEMENT = 'required-roles'
    resolveAuthContextMock.mockResolvedValue({ identity: SESSION_USER })
    await requireAuthContext(makeEvent())

    expect(resolveAuthContextMock).toHaveBeenCalledWith('fake-db', { userId: 'user-1', organizationId: 'org-1', sessionVersion: 1 }, undefined, { enforceTwoFactor: true })
  })

  it('accepts a session without a kind (pre-Phase-2) and an explicit staff session', async () => {
    resolveAuthContextMock.mockResolvedValue({ identity: SESSION_USER })
    requireUserSessionMock.mockResolvedValueOnce({ user: { ...SESSION_USER, kind: 'staff' } })

    await expect(requireAuthContext(makeEvent())).resolves.toEqual({ identity: SESSION_USER })
    await expect(requireAuthContext(makeEvent())).resolves.toEqual({ identity: SESSION_USER })
  })

  it.each(['agency', 'customer'])('answers a %s session 401 UNAUTHENTICATED without resolving or clearing it', async (kind) => {
    requireUserSessionMock.mockResolvedValue({ user: { ...SESSION_USER, kind } })

    const error = await requireAuthContext(makeEvent()).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(UnauthenticatedError)
    expect((error as UnauthenticatedError).code).toBe('UNAUTHENTICATED')
    expect(resolveAuthContextMock).not.toHaveBeenCalled()
    expect(clearUserSessionMock).not.toHaveBeenCalled()
  })
})
