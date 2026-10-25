import { customerRequestSchema } from '@hajj/contracts/schemas/booking'
import { requestCustomerStay } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Public site (v7 §6, §10): request the chosen option with the lead pilgrim's passport (REQUESTED until the hotel confirms). */
export default defineApiHandler({
  body: customerRequestSchema,
  auth: 'customer',
  handler: ({ ctx, body }) => requestCustomerStay(ctx, body),
})
