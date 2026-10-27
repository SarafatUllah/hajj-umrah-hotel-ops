import { createTransport } from 'nodemailer'
import { ServiceUnavailableError } from '../errors/domainError'
import { getEnv, type Mailbox } from '../utils/env'

export interface EmailMessage { to: string, subject: string, text: string, html: string }

/** Sends one e-mail; throws `ServiceUnavailableError` (503 `EMAIL_UNAVAILABLE`) when it cannot. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

const unavailable = () => new ServiceUnavailableError('EMAIL_UNAVAILABLE', 'E-mails cannot be sent right now')

/** The longest a provider may take to accept a message (a sign-in waits for it). */
const SEND_TIMEOUT_MS = 10_000
const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

/** The address with its local part cut to the first character (`a…@example.com`), for logs. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@')
  return at > 0 ? `${address[0]}…${address.slice(at)}` : '…'
}

/** A sender as a `From` header: `"Name" <address>`, or the bare address (the name holds no quotes: env.ts). */
export function formatMailbox(mailbox: Mailbox): string {
  return mailbox.name ? `"${mailbox.name}" <${mailbox.address}>` : mailbox.address
}

/** `EMAIL_DRIVER=disabled` (default): e-mail sign-in is off until a provider is configured. */
const disabledSender: EmailSender = {
  send: async () => { throw unavailable() },
}

/** `EMAIL_DRIVER=log` (APP_ENV=development only): writes the message to the server log, the address masked. */
const logSender: EmailSender = {
  send: async (message) => { console.info(`[email] to ${maskEmail(message.to)}: ${message.subject}\n${message.text}`) },
}

/** What an SMTP failure says about itself (nodemailer's code, the server's reply code): never its text, which may name the address. */
function smtpFailure(error: unknown): string {
  const { code, responseCode } = (error ?? {}) as { code?: unknown, responseCode?: unknown }
  const name = typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error'
  return typeof responseCode === 'number' ? `${name} ${responseCode}` : name
}

/**
 * `EMAIL_DRIVER=smtp`: one SMTP submission per message, always over TLS — implicit TLS on port 465 (Gmail:
 * smtp.gmail.com with an app password), STARTTLS required on any other port; the server's certificate is checked. A
 * refused login, a timeout or a refused message is a 503 to the caller, logged with its code only (the message carries
 * a sign-in code, the error may name the address).
 */
function smtpSender(settings: { host: string, port: number, user: string, password: string, from: Mailbox }): EmailSender {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    requireTLS: true,
    auth: { user: settings.user, pass: settings.password },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  })
  const from = settings.from.name ? { name: settings.from.name, address: settings.from.address } : settings.from.address
  return {
    async send(message) {
      try {
        await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html })
      }
      catch (error) {
        console.error('[email] delivery failed:', smtpFailure(error))
        throw unavailable()
      }
    },
  }
}

/** The error name Resend gives with a refusal (`validation_error`, …): safe to log, unlike its message. */
async function resendErrorName(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { name?: unknown } | null
  return typeof body?.name === 'string' ? ` (${body.name})` : ''
}

/**
 * `EMAIL_DRIVER=resend`: POSTs `{ from, to, subject, text, html }` to Resend's API with `Authorization: Bearer
 * RESEND_API_KEY` (no SDK). Sending needs a domain verified in Resend: without one it delivers only to the account
 * owner's own address. Any non-2xx answer or network error is a 503 to the caller, logged without the message.
 */
function resendSender(apiKey: string, from: Mailbox): EmailSender {
  return {
    async send(message) {
      try {
        const response = await fetch(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ from: formatMailbox(from), to: message.to, subject: message.subject, text: message.text, html: message.html }),
          // A redirect would re-send the message (and the key) to wherever it points: never follow one.
          redirect: 'error',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`Resend answered ${response.status}${await resendErrorName(response)}`)
      }
      catch (error) {
        console.error('[email] delivery failed:', error instanceof Error ? error.message : error)
        throw unavailable()
      }
    },
  }
}

let override: EmailSender | null = null

/** Whether e-mails can be sent at all (`EMAIL_DRIVER` is not `disabled`): optional messages are skipped otherwise. */
export function isEmailEnabled(): boolean {
  return override !== null || getEnv().EMAIL_DRIVER !== 'disabled'
}

/** The process's e-mail sender, chosen by `EMAIL_DRIVER` (its settings checked at startup: env.ts). */
export function useEmailSender(): EmailSender {
  if (override) return override
  const env = getEnv()
  if (env.EMAIL_DRIVER === 'log') return logSender
  if (env.EMAIL_DRIVER === 'smtp') return smtpSender({ host: env.SMTP_HOST!, port: env.SMTP_PORT, user: env.SMTP_USER!, password: env.SMTP_PASSWORD!, from: env.EMAIL_FROM! })
  if (env.EMAIL_DRIVER === 'resend') return resendSender(env.RESEND_API_KEY!, env.EMAIL_FROM!)
  return disabledSender
}

/** Test hook: capture or fake outgoing e-mail (`null` restores the configured driver). */
export function setEmailSenderForTests(sender: EmailSender | null): void {
  override = sender
}

/** One paragraph of a plain e-mail; `{ strong }` stands out in the HTML (a sign-in code). */
export type EmailParagraph = string | { strong: string }

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]!)

/** An e-mail of a few short paragraphs: the plain text, and the same as minimal HTML (every paragraph escaped). */
export function composeEmail(to: string, subject: string, paragraphs: readonly EmailParagraph[]): EmailMessage {
  const textOf = (paragraph: EmailParagraph) => (typeof paragraph === 'string' ? paragraph : paragraph.strong)
  const htmlOf = (paragraph: EmailParagraph) => (typeof paragraph === 'string'
    ? `<p>${escapeHtml(paragraph)}</p>`
    : `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(paragraph.strong)}</p>`)
  return {
    to,
    subject,
    text: paragraphs.map(textOf).join('\n\n'),
    html: `<!doctype html><html><body style="font-family:sans-serif;font-size:16px;line-height:1.5">${paragraphs.map(htmlOf).join('')}</body></html>`,
  }
}
