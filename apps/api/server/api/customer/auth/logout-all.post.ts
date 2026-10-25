import { signOutEverywhere } from '../../../services/accounts'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Ends every session of the signed-in customer, on every device. */
export default defineApiHandler({
  auth: 'customer',
  handler: async ({ event, ctx }) => {
    await signOutEverywhere(ctx)
    await clearUserSession(event)
    return { success: true }
  },
})
