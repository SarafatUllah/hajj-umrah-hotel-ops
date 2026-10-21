import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { confirmBooking } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Ops console (v7 §7): confirm an agency's hold or an individual's request before it lapses (`booking.create`). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => confirmBooking(ctx, params.bookingId),
})
