import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { customerBookingReceipt } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Public site (v7 §7): the receipt with its QR once the hotel confirmed the request. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'customer',
  handler: ({ ctx, params }) => customerBookingReceipt(ctx, params.bookingId),
})
