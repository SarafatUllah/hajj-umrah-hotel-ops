import { randomInt, timingSafeEqual } from 'node:crypto'
import { OTP_CODE_LENGTH } from '@hajj/contracts/constants/accounts'
import { usePiiCipher } from '../utils/pii'

/** A uniformly random numeric code (CSPRNG). */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0')
}

/** HMAC of the code bound to its challenge (keyed by the PII lookup key): a stored hash is useless for another challenge. */
export function hashOtpCode(challengeId: string, code: string): string {
  return usePiiCipher().blindIndex(code, `otp_challenge:${challengeId}`)
}

export function otpCodeMatches(challengeId: string, code: string, storedHash: string): boolean {
  const given = Buffer.from(hashOtpCode(challengeId, code), 'utf8')
  const stored = Buffer.from(storedHash, 'utf8')
  return given.length === stored.length && timingSafeEqual(given, stored)
}
