import { getCustomerMe } from '../../../services/accounts'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  auth: 'customer',
  handler: async ({ ctx }) => getCustomerMe(ctx),
})
