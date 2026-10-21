import { getAgencyMe } from '../../../services/accounts'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Allowed whatever the agency's status, so a pending agency sees where it stands. */
export default defineApiHandler({
  auth: 'agency-any-status',
  handler: async ({ ctx }) => getAgencyMe(ctx),
})
