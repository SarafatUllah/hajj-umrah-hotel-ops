import { z } from 'zod'
import { OTP_CODE_LENGTH } from '../constants/accounts'
import { e164Phone, safeText, uuid } from './common'

/** `POST /api/customer/auth/otp/request` (public site): text a one-time code to this phone. */
export const otpRequestSchema = z.object({
  organizationSlug: z.string().min(1).max(100),
  phone: e164Phone,
  /** The bot-check token (Cloudflare Turnstile) when the server requires one. */
  captchaToken: z.string().min(1).max(4096).optional(),
}).strict()
export type OtpRequestInput = z.infer<typeof otpRequestSchema>

/** `POST /api/customer/auth/otp/verify`: the code signs the customer in; a new customer also gives a name. */
export const otpVerifySchema = z.object({
  organizationSlug: z.string().min(1).max(100),
  challengeId: uuid,
  code: z.string().regex(new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`), `Enter the ${OTP_CODE_LENGTH}-digit code`),
  fullName: safeText(200).refine(v => v.length > 0, 'Required').optional(),
}).strict()
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>
