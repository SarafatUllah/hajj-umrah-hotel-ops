import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDemoEnv, getEnv, getStorageEnv, isDemoSignInEnabled, resetEnvCache } from '../../../server/utils/env'

const REQUIRED_VARS = {
  DATABASE_URL: 'postgres://user:pass@localhost:5433/db',
  NUXT_SESSION_PASSWORD: 'a'.repeat(32),
  PII_ENCRYPTION_KEYS: `t1:${Buffer.alloc(32, 1).toString('base64')}`,
  PII_LOOKUP_KEY: Buffer.alloc(32, 2).toString('base64'),
}

const S3_VARS = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'https://project.storage.example.com/storage/v1/s3',
  S3_REGION: 'ap-south-1',
  S3_BUCKET: 'hotel-files',
  S3_ACCESS_KEY_ID: 'key-id',
  S3_SECRET_ACCESS_KEY: 'secret',
}

describe('getEnv', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetEnvCache()
    for (const key of Object.keys(REQUIRED_VARS)) Reflect.deleteProperty(process.env, key)
    delete process.env.APP_ENV
    delete process.env.STORAGE_DRIVER
    delete process.env.STORAGE_LOCAL_DIR
    for (const key of Object.keys(S3_VARS)) Reflect.deleteProperty(process.env, key)
    delete process.env.S3_FORCE_PATH_STYLE
    delete process.env.ALLOW_DEMO_SEED
    delete process.env.DEMO_ANCHOR_DATE
    delete process.env.DEMO_SIGN_IN_ENABLED
    delete process.env.NUXT_SESSION_COOKIE_SECURE
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    resetEnvCache()
  })

  it('parses valid environment variables', () => {
    Object.assign(process.env, REQUIRED_VARS, { APP_ENV: 'development' })
    const env = getEnv()
    expect(env.DATABASE_URL).toBe(REQUIRED_VARS.DATABASE_URL)
    expect(env.APP_ENV).toBe('development')
  })

  it('defaults APP_ENV to development when unset', () => {
    Object.assign(process.env, REQUIRED_VARS)
    expect(getEnv().APP_ENV).toBe('development')
  })

  it('throws when DATABASE_URL is missing', () => {
    process.env.NUXT_SESSION_PASSWORD = REQUIRED_VARS.NUXT_SESSION_PASSWORD
    expect(() => getEnv()).toThrow(/DATABASE_URL/)
  })

  it('throws when NUXT_SESSION_PASSWORD is shorter than 32 characters', () => {
    Object.assign(process.env, REQUIRED_VARS, { NUXT_SESSION_PASSWORD: 'too-short' })
    expect(() => getEnv()).toThrow(/NUXT_SESSION_PASSWORD/)
  })

  it('rejects an unknown APP_ENV value', () => {
    Object.assign(process.env, REQUIRED_VARS, { APP_ENV: 'not-a-real-env' })
    expect(() => getEnv()).toThrow()
  })

  it('defaults DATABASE_POOL_MAX to 10 when unset', () => {
    Object.assign(process.env, REQUIRED_VARS)
    expect(getEnv().DATABASE_POOL_MAX).toBe(10)
  })

  it.each(['0', '51', 'abc'])('rejects DATABASE_POOL_MAX=%s', (value) => {
    Object.assign(process.env, REQUIRED_VARS, { DATABASE_POOL_MAX: value })
    expect(() => getEnv()).toThrow()
  })

  it('accepts a valid DATABASE_POOL_MAX', () => {
    Object.assign(process.env, REQUIRED_VARS, { DATABASE_POOL_MAX: '25' })
    expect(getEnv().DATABASE_POOL_MAX).toBe(25)
  })

  it('defaults the storage settings to the local driver under .data/uploads', () => {
    Object.assign(process.env, REQUIRED_VARS)
    delete process.env.STORAGE_DRIVER
    delete process.env.STORAGE_LOCAL_DIR
    expect(getEnv()).toMatchObject({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '.data/uploads' })
  })

  it('accepts an explicit local driver and directory', () => {
    Object.assign(process.env, REQUIRED_VARS, { STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '/var/lib/hotel-uploads' })
    expect(getEnv()).toMatchObject({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '/var/lib/hotel-uploads' })
  })

  it.each(['S3', 'LOCAL', 'azure', ''])('rejects the unsupported STORAGE_DRIVER=%j explicitly (no silent fallback to local)', (value) => {
    Object.assign(process.env, REQUIRED_VARS, { STORAGE_DRIVER: value })
    expect(() => getEnv()).toThrow(/STORAGE_DRIVER/)
  })

  it('getStorageEnv validates only the storage settings (database settings may be absent) and rejects an unsupported driver', () => {
    delete process.env.DATABASE_URL
    delete process.env.STORAGE_DRIVER
    expect(getStorageEnv()).toMatchObject({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '.data/uploads' })
    process.env.STORAGE_DRIVER = 'azure'
    expect(() => getStorageEnv()).toThrow(/STORAGE_DRIVER/)
  })

  it('accepts the s3 driver with all of its settings; path-style addressing is off unless asked for', () => {
    Object.assign(process.env, REQUIRED_VARS, S3_VARS)
    expect(getEnv()).toMatchObject({ ...S3_VARS, S3_FORCE_PATH_STYLE: false })
    resetEnvCache()
    process.env.S3_FORCE_PATH_STYLE = 'true'
    expect(getEnv().S3_FORCE_PATH_STYLE).toBe(true)
  })

  it.each(['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])('refuses the s3 driver without %s', (missing) => {
    Object.assign(process.env, REQUIRED_VARS, S3_VARS)
    Reflect.deleteProperty(process.env, missing)
    expect(() => getEnv()).toThrow(new RegExp(`${missing}: ${missing} is required with STORAGE_DRIVER=s3`))
  })

  it('refuses a plain-http S3 endpoint outside development (files would travel in clear text); development may use a local one', () => {
    Object.assign(process.env, REQUIRED_VARS, S3_VARS, { S3_ENDPOINT: 'http://127.0.0.1:9000', APP_ENV: 'demo' })
    expect(() => getEnv()).toThrow(/S3_ENDPOINT must be https outside APP_ENV=development/)
    resetEnvCache()
    process.env.APP_ENV = 'development'
    expect(getEnv().S3_ENDPOINT).toBe('http://127.0.0.1:9000')
  })

  it('getStorageEnv applies the s3 rules too, without the database settings', () => {
    delete process.env.DATABASE_URL
    Object.assign(process.env, S3_VARS)
    expect(getStorageEnv()).toMatchObject({ STORAGE_DRIVER: 's3', S3_BUCKET: 'hotel-files' })
    delete process.env.S3_BUCKET
    expect(() => getStorageEnv()).toThrow(/S3_BUCKET is required/)
  })

  it('rejects a blank STORAGE_LOCAL_DIR', () => {
    Object.assign(process.env, REQUIRED_VARS, { STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '   ' })
    expect(() => getEnv()).toThrow(/STORAGE_LOCAL_DIR/)
  })

  it('defaults the worker to the heavy queues and both kinds of process to a 2 s polling interval', () => {
    Object.assign(process.env, REQUIRED_VARS)
    delete process.env.WORKER_JOBS
    delete process.env.JOBS_POLL_SECONDS
    expect(getEnv()).toMatchObject({ WORKER_JOBS: 'heavy', JOBS_POLL_SECONDS: 2 })
  })

  it('lets the worker work every queue (a host where the API only enqueues) and poll less often', () => {
    Object.assign(process.env, REQUIRED_VARS, { WORKER_JOBS: 'all', JOBS_POLL_SECONDS: '30' })
    expect(getEnv()).toMatchObject({ WORKER_JOBS: 'all', JOBS_POLL_SECONDS: 30 })
  })

  it.each([['WORKER_JOBS', 'light'], ['WORKER_JOBS', 'ALL'], ['JOBS_POLL_SECONDS', '0'], ['JOBS_POLL_SECONDS', '301'], ['JOBS_POLL_SECONDS', 'often']])('rejects %s=%j', (name, value) => {
    Object.assign(process.env, REQUIRED_VARS, { [name]: value })
    expect(() => getEnv()).toThrow(new RegExp(name))
  })

  it('connects without TLS by default; DATABASE_SSL takes off, require or verify, and the CA must be a PEM certificate', () => {
    Object.assign(process.env, REQUIRED_VARS)
    delete process.env.DATABASE_SSL
    delete process.env.DATABASE_SSL_CA
    expect(getEnv().DATABASE_SSL).toBe('off')
    resetEnvCache()
    Object.assign(process.env, { DATABASE_SSL: 'verify', DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----' })
    expect(getEnv()).toMatchObject({ DATABASE_SSL: 'verify' })
    resetEnvCache()
    process.env.DATABASE_SSL = 'true'
    expect(() => getEnv()).toThrow(/DATABASE_SSL must be off, require or verify/)
    resetEnvCache()
    Object.assign(process.env, { DATABASE_SSL: 'verify', DATABASE_SSL_CA: 'not a certificate' })
    expect(() => getEnv()).toThrow(/DATABASE_SSL_CA must be a PEM certificate/)
  })

  it('refuses a CA certificate cut short (a multi-line paste that kept only its first line), accepts one pasted on one line', () => {
    Object.assign(process.env, REQUIRED_VARS, { DATABASE_SSL: 'verify', DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----' })
    expect(() => getEnv()).toThrow(/DATABASE_SSL_CA must be a whole PEM certificate/)
    resetEnvCache()
    process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----\\n'
    expect(getEnv()).toMatchObject({ DATABASE_SSL: 'verify' })
  })

  it('trusts the frontends\' visitor-address header only when TRUST_VISITOR_HEADER is "true"', () => {
    Object.assign(process.env, REQUIRED_VARS)
    delete process.env.TRUST_VISITOR_HEADER
    expect(getEnv().TRUST_VISITOR_HEADER).toBe(false)
    resetEnvCache()
    process.env.TRUST_VISITOR_HEADER = 'true'
    expect(getEnv().TRUST_VISITOR_HEADER).toBe(true)
    resetEnvCache()
    process.env.TRUST_VISITOR_HEADER = 'yes'
    expect(() => getEnv()).toThrow(/TRUST_VISITOR_HEADER must be "true" or "false"/)
    delete process.env.TRUST_VISITOR_HEADER
  })

  it('leaves the job tick off unless JOBS_TICK_SECRET is set, and refuses a short secret', () => {
    Object.assign(process.env, REQUIRED_VARS)
    delete process.env.JOBS_TICK_SECRET
    expect(getEnv().JOBS_TICK_SECRET).toBeUndefined()
    resetEnvCache()
    process.env.JOBS_TICK_SECRET = 'x'.repeat(32)
    expect(getEnv().JOBS_TICK_SECRET).toBe('x'.repeat(32))
    resetEnvCache()
    process.env.JOBS_TICK_SECRET = 'too-short'
    expect(() => getEnv()).toThrow(/JOBS_TICK_SECRET must be at least 32 characters/)
  })

  it('caches the parsed result until resetEnvCache is called', () => {
    Object.assign(process.env, REQUIRED_VARS)
    const first = getEnv()
    process.env.DATABASE_URL = 'postgres://changed/db'
    const second = getEnv()
    expect(second.DATABASE_URL).toBe(first.DATABASE_URL)
    resetEnvCache()
    const third = getEnv()
    expect(third.DATABASE_URL).toBe('postgres://changed/db')
  })

  describe('demo settings (Task 20)', () => {
    it('defaults: no production seeding override, anchor 2026-09-01, demo sign-in off', () => {
      Object.assign(process.env, REQUIRED_VARS)
      expect(getEnv()).toMatchObject({ ALLOW_DEMO_SEED: false, DEMO_ANCHOR_DATE: '2026-09-01', DEMO_SIGN_IN_ENABLED: false })
    })

    it('accepts explicit values', () => {
      Object.assign(process.env, REQUIRED_VARS, { ALLOW_DEMO_SEED: 'true', DEMO_ANCHOR_DATE: '2027-01-15', DEMO_SIGN_IN_ENABLED: 'true', APP_ENV: 'demo' })
      expect(getEnv()).toMatchObject({ ALLOW_DEMO_SEED: true, DEMO_ANCHOR_DATE: '2027-01-15', DEMO_SIGN_IN_ENABLED: true })
    })

    it.each(['2026-02-30', '2026-13-01', '2026-9-1', 'tomorrow', '2026-09-01T00:00:00Z', '', '1800-01-01', '1999-12-31', '2101-01-01'])('rejects DEMO_ANCHOR_DATE=%j (must be a real ISO date)', (value) => {
      Object.assign(process.env, REQUIRED_VARS, { DEMO_ANCHOR_DATE: value })
      expect(() => getEnv()).toThrow(/DEMO_ANCHOR_DATE/)
    })

    it.each(['2000-01-01', '2100-12-31'])('accepts the window edge DEMO_ANCHOR_DATE=%s', (value) => {
      Object.assign(process.env, REQUIRED_VARS, { DEMO_ANCHOR_DATE: value })
      expect(getEnv().DEMO_ANCHOR_DATE).toBe(value)
    })

    it.each(['1', 'TRUE', 'yes', ''])('rejects the non-boolean flag value %j instead of silently reading it as false', (value) => {
      Object.assign(process.env, REQUIRED_VARS, { DEMO_SIGN_IN_ENABLED: value })
      expect(() => getEnv()).toThrow(/DEMO_SIGN_IN_ENABLED/)
      delete process.env.DEMO_SIGN_IN_ENABLED
      process.env.ALLOW_DEMO_SEED = value
      expect(() => getEnv()).toThrow(/ALLOW_DEMO_SEED/)
    })

    it('rejects DEMO_SIGN_IN_ENABLED=true with APP_ENV=production (startup must fail)', () => {
      Object.assign(process.env, REQUIRED_VARS, { APP_ENV: 'production', DEMO_SIGN_IN_ENABLED: 'true' })
      expect(() => getEnv()).toThrow(/DEMO_SIGN_IN_ENABLED=true is not allowed with APP_ENV=production/)
      expect(() => getDemoEnv()).toThrow(/APP_ENV=production/)
    })

    it('accepts DEMO_SIGN_IN_ENABLED=true with APP_ENV=staging (valid configuration; the runtime gate keeps the endpoint closed)', () => {
      Object.assign(process.env, REQUIRED_VARS, { APP_ENV: 'staging', DEMO_SIGN_IN_ENABLED: 'true' })
      expect(getEnv()).toMatchObject({ APP_ENV: 'staging', DEMO_SIGN_IN_ENABLED: true })
      expect(getDemoEnv()).toMatchObject({ APP_ENV: 'staging', DEMO_SIGN_IN_ENABLED: true })
      expect(isDemoSignInEnabled({ APP_ENV: 'staging', DEMO_SIGN_IN_ENABLED: 'true' })).toBe(false)
      expect(isDemoSignInEnabled()).toBe(false)
    })

    it.each(['production', 'staging'])('allows DEMO_SIGN_IN_ENABLED=false under APP_ENV=%s', (appEnv) => {
      Object.assign(process.env, REQUIRED_VARS, { APP_ENV: appEnv, DEMO_SIGN_IN_ENABLED: 'false', STAFF_2FA_ENFORCEMENT: 'required-roles' })
      expect(getEnv().DEMO_SIGN_IN_ENABLED).toBe(false)
    })

    it.each(['development', 'demo'])('allows DEMO_SIGN_IN_ENABLED=false under APP_ENV=%s', (appEnv) => {
      Object.assign(process.env, REQUIRED_VARS, { APP_ENV: appEnv, DEMO_SIGN_IN_ENABLED: 'false' })
      expect(getEnv().DEMO_SIGN_IN_ENABLED).toBe(false)
      expect(isDemoSignInEnabled({ APP_ENV: appEnv, DEMO_SIGN_IN_ENABLED: 'false' })).toBe(false)
    })

    it.each(['development', 'demo'])('allows DEMO_SIGN_IN_ENABLED=true under APP_ENV=%s (and the runtime gate opens)', (appEnv) => {
      Object.assign(process.env, REQUIRED_VARS, { APP_ENV: appEnv, DEMO_SIGN_IN_ENABLED: 'true' })
      expect(getEnv().DEMO_SIGN_IN_ENABLED).toBe(true)
      expect(getDemoEnv().DEMO_SIGN_IN_ENABLED).toBe(true)
      expect(isDemoSignInEnabled({ APP_ENV: appEnv, DEMO_SIGN_IN_ENABLED: 'true' })).toBe(true)
    })

    it('getDemoEnv validates only the demo settings (database settings may be absent) and is never cached', () => {
      expect(getDemoEnv({})).toEqual({ APP_ENV: 'development', ALLOW_DEMO_SEED: false, DEMO_ANCHOR_DATE: '2026-09-01', DEMO_SIGN_IN_ENABLED: false })
      expect(getDemoEnv({ DEMO_ANCHOR_DATE: '2027-03-03' }).DEMO_ANCHOR_DATE).toBe('2027-03-03')
      expect(getDemoEnv({ APP_ENV: 'production', ALLOW_DEMO_SEED: 'true' })).toMatchObject({ APP_ENV: 'production', ALLOW_DEMO_SEED: true })
    })

    describe('isDemoSignInEnabled (the runtime gate; fail-closed)', () => {
      it.each([
        ['development', 'true', true],
        ['demo', 'true', true],
        ['development', 'false', false],
        ['demo', undefined, false],
        ['production', 'false', false],
        ['production', undefined, false],
        ['staging', 'false', false],
        // Staging + true is a VALID configuration, but the gate stays closed there.
        ['staging', 'true', false],
        // Invalid combinations never open the gate (and never throw).
        ['production', 'true', false],
        ['development', 'TRUE', false],
        ['not-an-env', 'true', false],
      ] as const)('APP_ENV=%s DEMO_SIGN_IN_ENABLED=%s -> %s', (appEnv, flag, expected) => {
        expect(isDemoSignInEnabled({ APP_ENV: appEnv, ...(flag === undefined ? {} : { DEMO_SIGN_IN_ENABLED: flag }) })).toBe(expected)
      })
    })
  })
})

describe('getEnv: Phase 2a security settings', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetEnvCache()
    process.env = { ...REQUIRED_VARS }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    resetEnvCache()
  })

  it('requires the PII key ring and lookup key, and rejects malformed ones without echoing them', () => {
    delete process.env.PII_ENCRYPTION_KEYS
    expect(() => getEnv()).toThrow(/PII_ENCRYPTION_KEYS/)
    resetEnvCache()
    process.env.PII_ENCRYPTION_KEYS = 'k1:dG9vLXNob3J0'
    expect(() => getEnv()).toThrow(/32 bytes/)
    expect(() => getEnv()).not.toThrow(/dG9vLXNob3J0/)
    resetEnvCache()
    process.env.PII_ENCRYPTION_KEYS = REQUIRED_VARS.PII_ENCRYPTION_KEYS
    process.env.PII_LOOKUP_KEY = 'c2hvcnQ='
    expect(() => getEnv()).toThrow(/PII lookup key/)
  })

  it('refuses a lookup key that is also an encryption key', () => {
    process.env.PII_LOOKUP_KEY = Buffer.alloc(32, 1).toString('base64')
    expect(() => getEnv()).toThrow(/PII_LOOKUP_KEY must differ/)
  })

  it('defaults TRUST_PROXY off, ALLOWED_ORIGINS empty and 2FA enforcement off outside production', () => {
    const env = getEnv()
    expect(env.TRUST_PROXY).toBe(false)
    expect(env.ALLOWED_ORIGINS).toEqual([])
    expect(env.STAFF_2FA_ENFORCEMENT).toBe('off')
  })

  it('parses ALLOWED_ORIGINS as exact origins and rejects paths or junk', () => {
    process.env.ALLOWED_ORIGINS = 'https://ops.example.com, https://agency.example.com'
    expect(getEnv().ALLOWED_ORIGINS).toEqual(['https://ops.example.com', 'https://agency.example.com'])
    resetEnvCache()
    process.env.ALLOWED_ORIGINS = 'https://ops.example.com/path'
    expect(() => getEnv()).toThrow(/exact origins/)
  })

  it('SMS: disabled by default, Saudi numbers only by default; log only in development; webhook needs https; Turnstile needs its secret', () => {
    expect(getEnv()).toMatchObject({ SMS_DRIVER: 'disabled', SMS_ALLOWED_CALLING_CODES: ['966'], SMS_HOURLY_LIMIT: 300, SMS_DAILY_LIMIT: 2000, CAPTCHA_DRIVER: 'off' })
    resetEnvCache()
    process.env.SMS_ALLOWED_CALLING_CODES = '966, 880,92'
    expect(getEnv().SMS_ALLOWED_CALLING_CODES).toEqual(['966', '880', '92'])
    resetEnvCache()
    process.env.SMS_ALLOWED_CALLING_CODES = '+966'
    expect(() => getEnv()).toThrow(/SMS_ALLOWED_CALLING_CODES/)
    resetEnvCache()
    delete process.env.SMS_ALLOWED_CALLING_CODES
    Object.assign(process.env, { APP_ENV: 'staging', SMS_DRIVER: 'log' })
    expect(() => getEnv()).toThrow(/SMS_DRIVER=log is allowed only with APP_ENV=development/)
    resetEnvCache()
    Object.assign(process.env, { APP_ENV: 'development', CAPTCHA_DRIVER: 'turnstile' })
    expect(() => getEnv()).toThrow(/CAPTCHA_SECRET is required/)
    resetEnvCache()
    delete process.env.CAPTCHA_DRIVER
    Object.assign(process.env, { APP_ENV: 'production', STAFF_2FA_ENFORCEMENT: 'required-roles', SMS_DRIVER: 'log' })
    expect(() => getEnv()).toThrow(/SMS_DRIVER=log is allowed only/)
    resetEnvCache()
    Object.assign(process.env, { SMS_DRIVER: 'webhook', SMS_WEBHOOK_URL: 'http://sms.example.test' })
    expect(() => getEnv()).toThrow(/SMS_WEBHOOK_URL \(https\)/)
    resetEnvCache()
    // Texting codes outside development needs the bot check (SMS pumping, a stranger's phone flooded) — staging too.
    process.env.SMS_WEBHOOK_URL = 'https://sms.example.test'
    expect(() => getEnv()).toThrow(/CAPTCHA_DRIVER must be turnstile/)
    resetEnvCache()
    process.env.APP_ENV = 'staging'
    expect(() => getEnv()).toThrow(/CAPTCHA_DRIVER must be turnstile/)
    resetEnvCache()
    process.env.APP_ENV = 'production'
    resetEnvCache()
    Object.assign(process.env, { CAPTCHA_DRIVER: 'turnstile', CAPTCHA_SECRET: 'turnstile-secret' })
    expect(getEnv().SMS_DRIVER).toBe('webhook')
  })

  it('e-mail: disabled by default; log only in development; each sending driver needs its settings, named but never echoed', () => {
    expect(getEnv()).toMatchObject({ EMAIL_DRIVER: 'disabled', SMTP_PORT: 465, EMAIL_HOURLY_LIMIT: 100, EMAIL_DAILY_LIMIT: 400 })
    expect(getEnv().EMAIL_FROM).toBeUndefined()
    resetEnvCache()
    Object.assign(process.env, { APP_ENV: 'staging', EMAIL_DRIVER: 'log' })
    expect(() => getEnv()).toThrow(/EMAIL_DRIVER=log is allowed only with APP_ENV=development/)
    resetEnvCache()
    Object.assign(process.env, { APP_ENV: 'development', EMAIL_DRIVER: 'smtp', SMTP_PASSWORD: 'app-password-secret' })
    for (const missing of ['SMTP_HOST', 'SMTP_USER', 'EMAIL_FROM']) expect(() => getEnv(), missing).toThrow(new RegExp(`${missing} is required with EMAIL_DRIVER=smtp`))
    expect(() => getEnv()).not.toThrow(/SMTP_PASSWORD is required|app-password-secret/)
    resetEnvCache()
    Object.assign(process.env, { SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'stays@gmail.com', EMAIL_FROM: 'Hajj & Umrah Stays <stays@gmail.com>' })
    expect(getEnv()).toMatchObject({ EMAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465, SMTP_USER: 'stays@gmail.com', EMAIL_FROM: { name: 'Hajj & Umrah Stays', address: 'stays@gmail.com' } })
    resetEnvCache()
    process.env.SMTP_PORT = '70000'
    expect(() => getEnv()).toThrow(/SMTP_PORT must be a port number/)
    resetEnvCache()
    Object.assign(process.env, { SMTP_PORT: '587', SMTP_PASSWORD: '' })
    expect(() => getEnv()).toThrow(/SMTP_PASSWORD/)
    resetEnvCache()
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', SMTP_PASSWORD: 'app-password-secret' })
    expect(() => getEnv()).toThrow(/RESEND_API_KEY is required with EMAIL_DRIVER=resend/)
    resetEnvCache()
    process.env.RESEND_API_KEY = 're_secret_key'
    expect(getEnv()).toMatchObject({ EMAIL_DRIVER: 'resend', SMTP_PORT: 587 })
    resetEnvCache()
    process.env.EMAIL_DRIVER = 'sendgrid'
    expect(() => getEnv()).toThrow(/EMAIL_DRIVER must be disabled, log, smtp or resend/)
  })

  it('EMAIL_FROM is an address or "Name <address>"; anything else is refused', () => {
    for (const [value, parsed] of [
      ['stays@example.com', { name: null, address: 'stays@example.com' }],
      ['Hajj & Umrah Stays <stays@example.com>', { name: 'Hajj & Umrah Stays', address: 'stays@example.com' }],
      [' "Hajj & Umrah Stays"  <stays@example.com> ', { name: 'Hajj & Umrah Stays', address: 'stays@example.com' }],
      ['<stays@example.com>', { name: null, address: 'stays@example.com' }],
    ] as const) {
      resetEnvCache()
      process.env.EMAIL_FROM = value
      expect(getEnv().EMAIL_FROM, value).toEqual(parsed)
    }
    for (const value of ['', 'Hajj Stays', 'Stays <not-an-address>', 'a@example.com, b@example.com', 'Stays "x" <stays@example.com>', 'Stays <stays@example.com', 'Stays\\ <stays@example.com>']) {
      resetEnvCache()
      process.env.EMAIL_FROM = value
      expect(() => getEnv(), value).toThrow(/EMAIL_FROM must be an address or "Name <address>"/)
    }
  })

  it('e-mailing sign-in codes outside development needs the bot check, as texting them does; the e-mail budget is per hour and per day', () => {
    const gmail = { EMAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'stays@gmail.com', SMTP_PASSWORD: 'app-password-secret', EMAIL_FROM: 'stays@gmail.com' }
    for (const appEnv of ['demo', 'staging']) {
      resetEnvCache()
      Object.assign(process.env, gmail, { APP_ENV: appEnv })
      expect(() => getEnv(), appEnv).toThrow(/CAPTCHA_DRIVER must be turnstile when sign-in codes are e-mailed outside APP_ENV=development/)
      expect(() => getEnv(), appEnv).not.toThrow(/app-password-secret/)
    }
    resetEnvCache()
    Object.assign(process.env, { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_secret_key' })
    expect(() => getEnv()).toThrow(/CAPTCHA_DRIVER must be turnstile when sign-in codes are e-mailed/)
    resetEnvCache()
    Object.assign(process.env, gmail, { CAPTCHA_DRIVER: 'turnstile', CAPTCHA_SECRET: 'turnstile-secret', EMAIL_HOURLY_LIMIT: '50', EMAIL_DAILY_LIMIT: '450' })
    expect(getEnv()).toMatchObject({ APP_ENV: 'staging', EMAIL_DRIVER: 'smtp', EMAIL_HOURLY_LIMIT: 50, EMAIL_DAILY_LIMIT: 450 })
    resetEnvCache()
    process.env.EMAIL_DAILY_LIMIT = '0'
    expect(() => getEnv()).toThrow(/EMAIL_DAILY_LIMIT/)
  })

  it('refuses the example session password outside development, and a cookie without Secure in production', () => {
    Object.assign(process.env, REQUIRED_VARS, { APP_ENV: 'staging', NUXT_SESSION_PASSWORD: 'change-this-to-a-random-32-plus-character-secret' })
    expect(() => getEnv()).toThrow(/NUXT_SESSION_PASSWORD is still the example value/)
    resetEnvCache()
    Object.assign(process.env, { APP_ENV: 'production', STAFF_2FA_ENFORCEMENT: 'required-roles', NUXT_SESSION_PASSWORD: REQUIRED_VARS.NUXT_SESSION_PASSWORD, NUXT_SESSION_COOKIE_SECURE: 'false' })
    expect(() => getEnv()).toThrow(/NUXT_SESSION_COOKIE_SECURE=false is not allowed with APP_ENV=production/)
    for (const off of ['FALSE', ' False ', '0', 'no']) {
      resetEnvCache()
      process.env.NUXT_SESSION_COOKIE_SECURE = off
      expect(() => getEnv(), off).toThrow(/NUXT_SESSION_COOKIE_SECURE/)
    }
    for (const on of ['true', 'TRUE', '1']) {
      resetEnvCache()
      process.env.NUXT_SESSION_COOKIE_SECURE = on
      expect(getEnv().APP_ENV).toBe('production')
    }
    resetEnvCache()
    delete process.env.NUXT_SESSION_COOKIE_SECURE
    expect(getEnv().APP_ENV).toBe('production')
  })

  it('refuses production without staff 2FA enforcement', () => {
    process.env.APP_ENV = 'production'
    expect(() => getEnv()).toThrow(/STAFF_2FA_ENFORCEMENT must be required-roles/)
    resetEnvCache()
    process.env.STAFF_2FA_ENFORCEMENT = 'required-roles'
    expect(getEnv().STAFF_2FA_ENFORCEMENT).toBe('required-roles')
  })
})
