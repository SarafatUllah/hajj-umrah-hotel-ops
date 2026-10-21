import { listBookingsQuerySchema } from '@hajj/contracts/schemas/booking'
import { listAgencyBookings } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Agency portal: the agency's own bookings, newest first. */
export default defineApiHandler({
  query: listBookingsQuerySchema,
  auth: 'agency',
  handler: ({ ctx, query }) => listAgencyBookings(ctx, query),
})
