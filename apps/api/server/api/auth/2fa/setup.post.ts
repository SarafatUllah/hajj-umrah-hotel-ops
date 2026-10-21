import { setResponseHeader } from 'h3'
import { beginTwoFactorSetup } from '../../../services/twoFactorService'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Starts enrolment and returns the new secret once (never cached: it is a credential). */
export default defineApiHandler({
  auth: 'required',
  allowTwoFactorEnrollmentPending: true,
  handler: async ({ event, ctx }) => {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return beginTwoFactorSetup(ctx)
  },
})
