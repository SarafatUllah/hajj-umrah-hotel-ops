import { twoFactorCodeSchema } from '@hajj/contracts/schemas/auth'
import { disableTwoFactor } from '../../../services/twoFactorService'
import { defineApiHandler } from '../../../utils/apiHandler'
import { refreshSessionVersion } from '../../../utils/requireAuth'

/** Turns 2FA off with a current code; every other session of the user ends, this one stays signed in. */
export default defineApiHandler({
  body: twoFactorCodeSchema,
  auth: 'required',
  allowTwoFactorEnrollmentPending: true,
  handler: async ({ event, ctx, body }) => {
    await refreshSessionVersion(event, await disableTwoFactor(ctx, body.code))
    return { enabled: false }
  },
})
