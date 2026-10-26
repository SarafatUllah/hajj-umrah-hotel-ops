import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeEmail, maskEmail, setEmailSenderForTests, useEmailSender, type EmailMessage } from '../../../server/notifications/email'

const envState = vi.hoisted(() => ({}) as Record<string, unknown>)
const smtp = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn() }))
vi.mock('../../../server/utils/env', () => ({ getEnv: () => envState }))
vi.mock('nodemailer', () => ({ createTransport: smtp.createTransport }))

const FROM = { name: 'Hajj & Umrah Stays', address: 'stays@example.test' }
const message: EmailMessage = { to: 'aisha@example.test', subject: 'Your sign-in code', text: 'code 123456', html: '<p>code 123456</p>' }
const SMTP_ENV = { EMAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.example.test', SMTP_PORT: 465, SMTP_USER: 'stays@example.test', SMTP_PASSWORD: 'app-password-secret', EMAIL_FROM: FROM }

describe('useEmailSender', () => {
  beforeEach(() => {
    for (const key of Object.keys(envState)) Reflect.deleteProperty(envState, key)
    envState.EMAIL_DRIVER = 'disabled'
    smtp.createTransport.mockReset().mockImplementation(() => ({ sendMail: smtp.sendMail }))
    smtp.sendMail.mockReset().mockResolvedValue({ accepted: [message.to] })
    setEmailSenderForTests(null)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('disabled (the default) answers 503 EMAIL_UNAVAILABLE', async () => {
    await expect(useEmailSender().send(message)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', httpStatus: 503 })
  })

  it('log writes the message to the server log, the address masked', async () => {
    envState.EMAIL_DRIVER = 'log'
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await useEmailSender().send(message)
    expect(info).toHaveBeenCalledWith('[email] to a…@example.test: Your sign-in code\ncode 123456')
  })

  it('smtp sends over implicit TLS on port 465 (Gmail), logged in with the app password, from the configured sender', async () => {
    Object.assign(envState, SMTP_ENV)
    await useEmailSender().send(message)
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example.test', port: 465, secure: true, requireTLS: true, auth: { user: 'stays@example.test', pass: 'app-password-secret' },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
    }))
    expect(smtp.sendMail).toHaveBeenCalledWith({ from: FROM, to: 'aisha@example.test', subject: 'Your sign-in code', text: 'code 123456', html: '<p>code 123456</p>' })
  })

  it('smtp on another port must upgrade with STARTTLS (never clear text); a bare sender address is sent as it is', async () => {
    Object.assign(envState, SMTP_ENV, { SMTP_PORT: 587, EMAIL_FROM: { name: null, address: 'stays@example.test' } })
    await useEmailSender().send(message)
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false, requireTLS: true }))
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'stays@example.test' }))
  })

  it('an SMTP failure is a 503, logged with its codes only: never the message, the address or the password', async () => {
    Object.assign(envState, SMTP_ENV)
    smtp.sendMail.mockRejectedValue(Object.assign(new Error('Invalid login: 535 for stays@example.test (code 123456)'), { code: 'EAUTH', responseCode: 535 }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(useEmailSender().send(message)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', httpStatus: 503 })
    expect(logged).toHaveBeenCalledWith('[email] delivery failed:', 'EAUTH 535')
    const logs = JSON.stringify(logged.mock.calls)
    for (const secret of ['123456', 'aisha', 'app-password-secret']) expect(logs).not.toContain(secret)
  })

  it('resend POSTs { from, to, subject, text, html } with the bearer key, no redirects, a timeout', async () => {
    Object.assign(envState, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key', EMAIL_FROM: FROM })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await useEmailSender().send(message)
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      signal: expect.any(AbortSignal),
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer re_test_key' },
    }))
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ from: '"Hajj & Umrah Stays" <stays@example.test>', to: 'aisha@example.test', subject: 'Your sign-in code', text: 'code 123456', html: '<p>code 123456</p>' })
  })

  it('a non-2xx answer from Resend or a network error is a 503 that never logs the message or the key', async () => {
    Object.assign(envState, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_key', EMAIL_FROM: FROM })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address (aisha@example.test)' }), { status: 403 })))
    await expect(useEmailSender().send(message)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', httpStatus: 503 })
    expect(logged).toHaveBeenCalledWith('[email] delivery failed:', 'Resend answered 403 (validation_error)')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(useEmailSender().send(message)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' })
    const logs = JSON.stringify(logged.mock.calls)
    for (const secret of ['123456', 'aisha', 're_test_key']) expect(logs).not.toContain(secret)
  })

  it('a test override wins until it is cleared', async () => {
    const sent: EmailMessage[] = []
    setEmailSenderForTests({ send: async (m) => { sent.push(m) } })
    await useEmailSender().send(message)
    expect(sent).toEqual([message])
    setEmailSenderForTests(null)
    await expect(useEmailSender().send(message)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' })
  })
})

describe('composeEmail', () => {
  it('gives the paragraphs as plain text and as escaped HTML, a strong paragraph standing out', () => {
    const email = composeEmail('aisha@example.test', 'Your sign-in code', ['Your code for Hajj & Umrah <Stays>:', { strong: '123456' }, 'It expires in 5 minutes.'])
    expect(email.text).toBe('Your code for Hajj & Umrah <Stays>:\n\n123456\n\nIt expires in 5 minutes.')
    expect(email.html).toContain('<p>Your code for Hajj &amp; Umrah &lt;Stays&gt;:</p>')
    expect(email.html).toMatch(/<p style="[^"]*font-weight:700[^"]*">123456<\/p>/)
    expect(email.html).not.toContain('<Stays>')
    expect(email).toMatchObject({ to: 'aisha@example.test', subject: 'Your sign-in code' })
  })
})

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('aisha@example.test')).toBe('a…@example.test')
    expect(maskEmail('not-an-address')).toBe('…')
  })
})
