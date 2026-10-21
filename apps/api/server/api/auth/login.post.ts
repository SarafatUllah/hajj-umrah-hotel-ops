import { z } from 'zod'
import { login } from '../../services/auth.service'
import { UnauthenticatedError } from '../../errors/domainError'
import { defineApiHandler } from '../../utils/apiHandler'
import { clientIp } from '../../utils/clientIp'
import { totpCodeSchema } from '@hajj/contracts/schemas/auth'

// Upper bounds keep a hostile body from feeding huge strings to Argon2 and the rate-limit hashes.
const bodySchema = z.object({
  organizationSlug: z.string().min(1).max(100),
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
  totpCode: totpCodeSchema.optional(),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'none',
  handler: async ({ event, body }) => {
    const result = await login(body, { clientIp: clientIp(event), now: new Date() })
    switch (result.status) {
      case 'invalid-credentials':
        // Deliberately identical error for "unknown organization", "unknown
        // email", and "wrong password" — do not let a client distinguish which
        // one failed (avoids tenant/organization enumeration).
        throw new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid organization, email, or password')
      case 'two-factor-required':
        throw new UnauthenticatedError('TWO_FACTOR_REQUIRED', 'Enter the code from your authenticator app')
      case 'invalid-two-factor':
        throw new UnauthenticatedError('TWO_FACTOR_INVALID', 'The authentication code is not valid')
    }

    // Identity only (Task 7): no permission/hotel-access snapshot goes into the session — those are
    // resolved fresh from the database on every request via resolveAuthContext. The session is
    // replaced, never merged, so nothing from an earlier session survives a new login.
    await replaceUserSession(event, {
      user: { ...result.user, kind: 'staff', sessionVersion: result.session.sessionVersion },
      loggedInAt: Date.now(),
    })

    return { user: result.user }
  },
})
