import { z } from 'zod'
import { cancelBookingSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { cancelBooking } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Ops console (`booking.cancel`, v7 §12): cancel a pending or confirmed booking with a reason; the seats are free at once. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: cancelBookingSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => cancelBooking(ctx, params.bookingId, body),
})
