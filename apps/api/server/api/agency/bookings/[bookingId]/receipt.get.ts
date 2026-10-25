import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { agencyBookingReceipt } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Agency portal (v7 §7): the receipt of a confirmed booking, with the QR token the hotel scans at check-in. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => agencyBookingReceipt(ctx, params.bookingId),
})
