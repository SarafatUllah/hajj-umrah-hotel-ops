import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps) for staff two-factor authentication (design
 * v7 §21 "স্টাফের জন্য 2FA"). Pure: time and the last accepted step are passed in, so verification is
 * deterministic and replay-safe (a code is accepted only for a step later than the last one used).
 */
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
/** Steps of clock skew tolerated on either side of "now". */
export const TOTP_WINDOW = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(data: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error('Invalid base32 secret')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xFF)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new random 160-bit secret, base32 (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpStepAt(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS)
}

/** The 6-digit code for `step` (RFC 4226 dynamic truncation). */
export function totpCodeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0F
  const binary = ((hmac[offset]! & 0x7F) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

export type TotpVerification = { ok: true, step: number } | { ok: false }

/** Accepts `code` for a step within ±TOTP_WINDOW of `now` that is strictly later than `lastStep`. */
export function verifyTotp(secret: string, code: string, now: Date, lastStep: number | null = null): TotpVerification {
  if (!/^\d{6}$/.test(code)) return { ok: false }
  const current = totpStepAt(now)
  const given = Buffer.from(code, 'utf8')
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (lastStep !== null && step <= lastStep) continue
    if (timingSafeEqual(Buffer.from(totpCodeAt(secret, step), 'utf8'), given)) return { ok: true, step }
  }
  return { ok: false }
}

/** `otpauth://` URI for authenticator apps (rendered as a QR code by the client). */
export function totpUri(input: { secret: string, issuer: string, account: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`)
  const params = new URLSearchParams({ secret: input.secret, issuer: input.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) })
  return `otpauth://totp/${label}?${params.toString()}`
}
