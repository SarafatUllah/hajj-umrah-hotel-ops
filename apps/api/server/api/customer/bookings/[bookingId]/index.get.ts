import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { getCustomerBooking } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Public site: one of the customer's own bookings. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'customer',
  handler: ({ ctx, params }) => getCustomerBooking(ctx, params.bookingId),
})
