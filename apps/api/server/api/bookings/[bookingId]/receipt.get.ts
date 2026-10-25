import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { bookingReceipt } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Ops console (v7 §7): the receipt of a confirmed booking (`booking.view`). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => bookingReceipt(ctx, params.bookingId),
})
