import { closeCustomerAccount } from '../../../services/customerAccountService'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Public site (step 15b): close the account — needs a fresh code; open requests are withdrawn; every session ends. */
export default defineApiHandler({
  auth: 'customer',
  handler: async ({ event, ctx }) => {
    const result = await closeCustomerAccount(ctx)
    await clearUserSession(event)
    return { closed: true, ...result }
  },
})
