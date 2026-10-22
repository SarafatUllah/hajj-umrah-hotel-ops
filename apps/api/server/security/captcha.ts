import { isIP } from 'node:net'
import { ValidationError } from '../errors/domainError'
import { getEnv } from '../utils/env'

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** Turnstile's answers that mean our configuration is wrong, not the visitor's token. */
const CONFIGURATION_ERRORS = new Set(['missing-input-secret', 'invalid-input-secret'])

interface SiteverifyAnswer { 'success'?: boolean, 'error-codes'?: string[] }

/**
 * Bot check for public, SMS-sending routes (v7 §21 "captcha when suspicious"). `CAPTCHA_DRIVER=off` (default)
 * accepts everything; `turnstile` verifies the client's token with Cloudflare Turnstile (secret in
 * CAPTCHA_SECRET). A missing or rejected token is 422 `CAPTCHA_FAILED`; Turnstile being unreachable fails closed.
 * A wrong secret or an HTTP error is logged (every visitor would be refused); a visitor's refused token is not.
 */
export async function assertHuman(token: string | undefined, clientIp: string): Promise<void> {
  const env = getEnv()
  if (env.CAPTCHA_DRIVER === 'off') return
  if (!token) throw new ValidationError('CAPTCHA_FAILED', 'Please complete the check')
  // `remoteip` is optional: the rate-limit subject of an IPv6 visitor (a /64 group) or "unknown" is not an address.
  const body = new URLSearchParams({ secret: env.CAPTCHA_SECRET!, response: token })
  if (isIP(clientIp)) body.set('remoteip', clientIp)
  let success = false
  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) console.error(`[captcha] Turnstile answered HTTP ${response.status}`)
    const answer = response.ok ? await response.json() as SiteverifyAnswer : null
    success = answer?.success === true
    const misconfigured = answer?.['error-codes']?.filter(code => CONFIGURATION_ERRORS.has(code)) ?? []
    if (misconfigured.length) console.error(`[captcha] Turnstile refused our configuration: ${misconfigured.join(', ')} (check CAPTCHA_SECRET)`)
  }
  catch (error) {
    console.error('[captcha] verification failed:', error instanceof Error ? error.message : error)
  }
  if (!success) throw new ValidationError('CAPTCHA_FAILED', 'Please complete the check')
}
