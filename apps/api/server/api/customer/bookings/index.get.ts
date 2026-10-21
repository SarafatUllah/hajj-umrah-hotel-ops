import { listBookingsQuerySchema } from '@hajj/contracts/schemas/booking'
import { listCustomerBookings } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Public site: the customer's own bookings, newest first. */
export default defineApiHandler({
  query: listBookingsQuerySchema,
  auth: 'customer',
  handler: ({ ctx, query }) => listCustomerBookings(ctx, query),
})
