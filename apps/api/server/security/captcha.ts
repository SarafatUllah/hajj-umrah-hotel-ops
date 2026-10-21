import { ValidationError } from '../errors/domainError'
import { getEnv } from '../utils/env'

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Bot check for public, SMS-sending routes (v7 §21 "captcha when suspicious"). `CAPTCHA_DRIVER=off` (default)
 * accepts everything; `turnstile` verifies the client's token with Cloudflare Turnstile (secret in
 * CAPTCHA_SECRET). A missing or rejected token is 422 `CAPTCHA_FAILED`; Turnstile being unreachable fails closed.
 */
export async function assertHuman(token: string | undefined, clientIp: string): Promise<void> {
  const env = getEnv()
  if (env.CAPTCHA_DRIVER === 'off') return
  if (!token) throw new ValidationError('CAPTCHA_FAILED', 'Please complete the check')
  let success = false
  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.CAPTCHA_SECRET!, response: token, remoteip: clientIp }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    success = response.ok && (await response.json() as { success?: boolean }).success === true
  }
  catch (error) {
    console.error('[captcha] verification failed:', error instanceof Error ? error.message : error)
  }
  if (!success) throw new ValidationError('CAPTCHA_FAILED', 'Please complete the check')
}
