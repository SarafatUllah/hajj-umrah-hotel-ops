import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { getBooking } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Ops console: one booking (`booking.view` on its hotel; another hotel's booking is 404). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => getBooking(ctx, params.bookingId),
})
