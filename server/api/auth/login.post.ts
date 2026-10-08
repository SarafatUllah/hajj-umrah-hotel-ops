import { z } from 'zod'
import { authenticate } from '../../services/auth.service'
import { UnauthenticatedError } from '../../errors/domainError'
import { defineApiHandler } from '../../utils/apiHandler'

const bodySchema = z.object({
  organizationSlug: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
})

export default defineApiHandler({
  body: bodySchema,
  auth: 'none',
  handler: async ({ event, body }) => {
    const result = await authenticate(body.organizationSlug, body.email, body.password)
    if (!result) {
      // Deliberately identical error for "unknown organization", "unknown
      // email", and "wrong password" — do not let a client distinguish which
      // one failed (avoids tenant/organization enumeration).
      throw new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid organization, email, or password')
    }

    // Identity only (Task 7): no permission/hotel-access snapshot goes into the session — those are
    // resolved fresh from the database on every request via resolveAuthContext.
    await setUserSession(event, {
      user: result.user,
      loggedInAt: Date.now(),
    })

    return { user: result.user }
  },
})
