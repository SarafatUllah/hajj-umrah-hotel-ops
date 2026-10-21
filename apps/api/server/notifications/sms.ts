import { ServiceUnavailableError } from '../errors/domainError'
import { getEnv } from '../utils/env'

export interface SmsMessage { to: string, text: string }

/** Sends one SMS; throws `ServiceUnavailableError` (503 `SMS_UNAVAILABLE`) when it cannot. */
export interface SmsSender {
  send(message: SmsMessage): Promise<void>
}

const unavailable = () => new ServiceUnavailableError('SMS_UNAVAILABLE', 'Text messages cannot be sent right now')

/** `SMS_DRIVER=disabled` (default): customer sign-in is off until an SMS gateway is configured. */
const disabledSender: SmsSender = {
  send: async () => { throw unavailable() },
}

/** `SMS_DRIVER=log` (APP_ENV=development only): writes the message to the server log, the phone masked. */
const logSender: SmsSender = {
  send: async (message) => { console.info(`[sms] to …${message.to.slice(-4)}: ${message.text}`) },
}

/**
 * `SMS_DRIVER=webhook`: POSTs `{ to, text }` as JSON to `SMS_WEBHOOK_URL` (an SMS gateway or a small relay to the
 * operator's provider), with `Authorization: Bearer SMS_WEBHOOK_TOKEN` when set. Any non-2xx answer or network
 * error is a 503 to the caller and is logged without the message text (it carries a sign-in code).
 */
function webhookSender(url: string, token: string | undefined): SmsSender {
  return {
    async send(message) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(message),
          // A redirect would re-send the code to wherever it points: never follow one.
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`SMS gateway answered ${response.status}`)
      }
      catch (error) {
        console.error('[sms] delivery failed:', error instanceof Error ? error.message : error)
        throw unavailable()
      }
    },
  }
}

let override: SmsSender | null = null

/** The process's SMS sender, chosen by `SMS_DRIVER`. */
export function useSmsSender(): SmsSender {
  if (override) return override
  const env = getEnv()
  if (env.SMS_DRIVER === 'log') return logSender
  if (env.SMS_DRIVER === 'webhook') return webhookSender(env.SMS_WEBHOOK_URL!, env.SMS_WEBHOOK_TOKEN)
  return disabledSender
}

/** Test hook: capture or fake outgoing SMS (`null` restores the configured driver). */
export function setSmsSenderForTests(sender: SmsSender | null): void {
  override = sender
}
