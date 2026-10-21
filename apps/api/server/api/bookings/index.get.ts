import { listBookingsQuerySchema } from '@hajj/contracts/schemas/booking'
import { listBookings } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

/** Ops console: bookings of the hotels the caller can access (`booking.view`), newest first. */
export default defineApiHandler({
  query: listBookingsQuerySchema,
  auth: 'required',
  handler: ({ ctx, query }) => listBookings(ctx, query),
})
