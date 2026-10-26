import { z } from 'zod'
import { OTP_CODE_LENGTH } from '../constants/accounts'
import { toLatinDigits } from '../utils/digits'
import { e164Phone, emailAddress, safeText, uuid } from './common'

const otpRequestBase = {
  organizationSlug: z.string().min(1).max(100),
  /** The bot-check token (Cloudflare Turnstile) when the server requires one. */
  captchaToken: z.string().min(1).max(4096).optional(),
}

/**
 * `POST /api/customer/auth/otp/request` (public site): send a one-time code to this phone (by SMS) or to this e-mail
 * address (D-P2-68) — exactly one of the two.
 */
export const otpRequestSchema = z.union([
  z.object({ ...otpRequestBase, phone: e164Phone }).strict(),
  z.object({ ...otpRequestBase, email: emailAddress }).strict(),
])
export type OtpRequestInput = z.infer<typeof otpRequestSchema>

/** `POST /api/customer/auth/otp/verify`: the code signs the customer in; a new customer also gives a name. */
export const otpVerifySchema = z.object({
  organizationSlug: z.string().min(1).max(100),
  challengeId: uuid,
  code: z.string().transform(toLatinDigits).pipe(z.string().regex(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`), `Enter the ${OTP_CODE_LENGTH}-digit code`)),
  fullName: safeText(200).refine(v => v.length > 0, 'Required').optional(),
}).strict()
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>
