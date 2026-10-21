import { z } from 'zod'

/** A 6-digit code from an authenticator app (RFC 6238 TOTP). */
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code')

/** Body of `POST /api/auth/2fa/enable` and `POST /api/auth/2fa/disable`. */
export const twoFactorCodeSchema = z.object({ code: totpCodeSchema })

/** Body of `POST /api/users/:userId/2fa/reset` (administrator, lost device). */
export const twoFactorResetSchema = z.object({ reason: z.string().trim().min(3).max(500) })
