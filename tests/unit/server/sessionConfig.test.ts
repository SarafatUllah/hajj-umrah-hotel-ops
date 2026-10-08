import { describe, expect, it, vi } from 'vitest'

// nuxt.config.ts calls the bare global `defineNuxtConfig`, which Nuxt auto-imports at build time.
// `nuxt/config`'s own implementation is a plain identity function (`(config) => config`), so
// stubbing it the same way here is enough to import the real config object outside a Nuxt build —
// no Nuxt runtime is started, this just inspects the plain object the file produces.
vi.stubGlobal('defineNuxtConfig', (config: unknown) => config)

interface SessionRuntimeConfig {
  maxAge?: number
  cookie?: { httpOnly?: boolean, sameSite?: string, secure?: boolean }
}

const configModule = await import('../../../nuxt.config') as { default: { runtimeConfig?: { session?: SessionRuntimeConfig } } }
const session = configModule.default.runtimeConfig?.session

describe('session lifetime configuration (nuxt.config.ts runtimeConfig.session)', () => {
  it('sets maxAge to 8 hours (A2)', () => {
    expect(session?.maxAge).toBe(60 * 60 * 8)
  })

  it('sets httpOnly, sameSite=lax, and secure cookie defaults', () => {
    expect(session?.cookie).toEqual({ httpOnly: true, sameSite: 'lax', secure: true })
  })
})
