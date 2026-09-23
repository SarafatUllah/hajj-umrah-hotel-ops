import { z } from 'zod'
import { authenticate } from '../../services/auth.service'

const bodySchema = z.object({
  organizationSlug: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, bodySchema.parse)
  const result = await authenticate(body.organizationSlug, body.email, body.password)
  if (!result) {
    // Deliberately identical error for "unknown organization", "unknown
    // email", and "wrong password" — do not let a client distinguish which
    // one failed (avoids tenant/organization enumeration).
    throw createError({ statusCode: 401, statusMessage: 'Invalid organization, email, or password' })
  }

  await setUserSession(event, {
    user: result.user,
    permissions: result.permissions,
    allHotels: result.allHotels,
    hotelIds: result.hotelIds,
    loggedInAt: Date.now(),
  })

  return { user: result.user }
})
