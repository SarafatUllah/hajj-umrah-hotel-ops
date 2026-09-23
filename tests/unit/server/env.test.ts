import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEnv, resetEnvCache } from '../../../server/utils/env'

const REQUIRED_VARS = {
  DATABASE_URL: 'postgres://user:pass@localhost:5433/db',
  NUXT_SESSION_PASSWORD: 'a'.repeat(32),
}

describe('getEnv', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    resetEnvCache()
    for (const key of Object.keys(REQUIRED_VARS)) Reflect.deleteProperty(process.env, key)
    delete process.env.APP_ENV
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
})
