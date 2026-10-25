import { customerStaySearchSchema } from '@hajj/contracts/schemas/booking'
import { searchCustomerStay } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Public site (v7 §6, §9): the options for a customer's stay, at the public price. */
export default defineApiHandler({
  body: customerStaySearchSchema,
  auth: 'customer',
  handler: ({ ctx, body }) => searchCustomerStay(ctx, body),
})
