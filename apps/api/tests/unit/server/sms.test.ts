import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSmsSenderForTests, useSmsSender } from '../../../server/notifications/sms'
import { generateOtpCode } from '../../../server/security/otp'

const envState: { SMS_DRIVER: string, SMS_WEBHOOK_URL?: string, SMS_WEBHOOK_TOKEN?: string } = { SMS_DRIVER: 'disabled' }
vi.mock('../../../server/utils/env', () => ({ getEnv: () => envState }))


describe('useSmsSender', () => {
  beforeEach(() => {
    envState.SMS_DRIVER = 'disabled'
    setSmsSenderForTests(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('disabled (the default) answers 503 SMS_UNAVAILABLE', async () => {
    await expect(useSmsSender().send({ to: '+966500000001', text: 'x' })).rejects.toMatchObject({ code: 'SMS_UNAVAILABLE', httpStatus: 503 })
  })

  it('log writes the message to the server log, the phone masked', async () => {
    envState.SMS_DRIVER = 'log'
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await useSmsSender().send({ to: '+966500000001', text: 'code 123456' })
    expect(info).toHaveBeenCalledWith('[sms] to …0001: code 123456')
  })

  it('webhook POSTs { to, text } with the bearer token; a failure is a 503 that never logs the text', async () => {
    Object.assign(envState, { SMS_DRIVER: 'webhook', SMS_WEBHOOK_URL: 'https://sms.example.test/send', SMS_WEBHOOK_TOKEN: 'tok' })
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await useSmsSender().send({ to: '+966500000001', text: 'code 123456' })
    expect(fetchMock).toHaveBeenCalledWith('https://sms.example.test/send', expect.objectContaining({ method: 'POST', redirect: 'error', body: JSON.stringify({ to: '+966500000001', text: 'code 123456' }), headers: expect.objectContaining({ authorization: 'Bearer tok' }) }))

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(useSmsSender().send({ to: '+966500000001', text: 'code 654321' })).rejects.toMatchObject({ code: 'SMS_UNAVAILABLE' })
    expect(JSON.stringify(logged.mock.calls)).not.toContain('654321')
  })

  it('a test override wins until it is cleared', async () => {
    const sent: unknown[] = []
    setSmsSenderForTests({ send: async m => { sent.push(m) } })
    await useSmsSender().send({ to: '+966500000001', text: 'x' })
    expect(sent).toHaveLength(1)
  })
})

describe('generateOtpCode', () => {
  it('is always six digits', () => {
    for (let i = 0; i < 200; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/)
  })
})
