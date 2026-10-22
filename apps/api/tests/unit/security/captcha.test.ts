import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertHuman } from '../../../server/security/captcha'

const envState: { CAPTCHA_DRIVER: string, CAPTCHA_SECRET?: string } = { CAPTCHA_DRIVER: 'off' }
vi.mock('../../../server/utils/env', () => ({ getEnv: () => envState }))


describe('assertHuman', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    envState.CAPTCHA_DRIVER = 'off'
  })

  it('off accepts everything, with or without a token', async () => {
    await expect(assertHuman(undefined, '1.2.3.4')).resolves.toBeUndefined()
  })

  it('turnstile: a missing token or a rejected one is 422 CAPTCHA_FAILED; an accepted one passes; an outage fails closed', async () => {
    Object.assign(envState, { CAPTCHA_DRIVER: 'turnstile', CAPTCHA_SECRET: 'secret' })
    await expect(assertHuman(undefined, '1.2.3.4')).rejects.toMatchObject({ code: 'CAPTCHA_FAILED', httpStatus: 422 })

    const verify = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', verify)
    await expect(assertHuman('token', '1.2.3.4')).resolves.toBeUndefined()
    const [, init] = verify.mock.calls[0] as unknown as [string, { body: URLSearchParams }]
    expect(init.body.toString()).toContain('remoteip=1.2.3.4')

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false })))
    await expect(assertHuman('token', '1.2.3.4')).rejects.toMatchObject({ code: 'CAPTCHA_FAILED' })

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await expect(assertHuman('token', '1.2.3.4')).rejects.toMatchObject({ code: 'CAPTCHA_FAILED' })
  })

  it('sends remoteip only when it is an address (an IPv6 /64 rate-limit group or "unknown" is not)', async () => {
    Object.assign(envState, { CAPTCHA_DRIVER: 'turnstile', CAPTCHA_SECRET: 'secret' })
    const verify = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', verify)
    await assertHuman('token', '2001:db8:0:0::/64')
    await assertHuman('token', 'unknown')
    await assertHuman('token', '2001:db8::1')
    const bodies = (verify.mock.calls as unknown as Array<[string, { body: URLSearchParams }]>).map(([, init]) => init.body)
    expect(bodies.map(body => body.get('remoteip'))).toEqual([null, null, '2001:db8::1'])
  })

  it('a wrong secret or an HTTP error is logged for the operators; a visitor\'s refused token is not', async () => {
    Object.assign(envState, { CAPTCHA_DRIVER: 'turnstile', CAPTCHA_SECRET: 'secret' })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ 'success': false, 'error-codes': ['invalid-input-response'] })))
    await expect(assertHuman('token', '1.2.3.4')).rejects.toMatchObject({ code: 'CAPTCHA_FAILED' })
    expect(errors).not.toHaveBeenCalled()

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ 'success': false, 'error-codes': ['invalid-input-secret'] })))
    await expect(assertHuman('token', '1.2.3.4')).rejects.toMatchObject({ code: 'CAPTCHA_FAILED' })
    expect(String(errors.mock.calls.at(-1))).toContain('invalid-input-secret')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    await expect(assertHuman('token', '1.2.3.4')).rejects.toMatchObject({ code: 'CAPTCHA_FAILED' })
    expect(String(errors.mock.calls.at(-1))).toContain('503')
  })
})
