import { twoFactorCodeSchema } from '@hajj/contracts/schemas/auth'
import { confirmTwoFactorSetup } from '../../../services/twoFactorService'
import { defineApiHandler } from '../../../utils/apiHandler'
import { refreshSessionVersion } from '../../../utils/requireAuth'

/** Confirms enrolment; every other session of the user ends, this one stays signed in. */
export default defineApiHandler({
  body: twoFactorCodeSchema,
  auth: 'required',
  allowTwoFactorEnrollmentPending: true,
  handler: async ({ event, ctx, body }) => {
    await refreshSessionVersion(event, await confirmTwoFactorSetup(ctx, body.code))
    return { enabled: true }
  },
})
