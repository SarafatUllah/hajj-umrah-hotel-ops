import { z } from 'zod'

/** A 6-digit code from an authenticator app (RFC 6238 TOTP). */
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code')

/**
 * Body of `POST /api/auth/login` (staff). Upper bounds keep a hostile body from feeding huge strings to Argon2 and the
 * rate-limit hashes. `totpCode` is sent once the API answered `TWO_FACTOR_REQUIRED`.
 */
export const staffLoginSchema = z.object({
  organizationSlug: z.string().min(1).max(100),
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
  totpCode: totpCodeSchema.optional(),
})
export type StaffLoginInput = z.infer<typeof staffLoginSchema>

/** Body of `POST /api/auth/2fa/enable` and `POST /api/auth/2fa/disable`. */
export const twoFactorCodeSchema = z.object({ code: totpCodeSchema })

/** Body of `POST /api/users/:userId/2fa/reset` (administrator, lost device). */
export const twoFactorResetSchema = z.object({ reason: z.string().trim().min(3).max(500) })
