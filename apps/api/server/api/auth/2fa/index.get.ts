import { getTwoFactorStatus } from '../../../services/twoFactorService'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  auth: 'required',
  allowTwoFactorEnrollmentPending: true,
  handler: async ({ ctx }) => getTwoFactorStatus(ctx),
})
