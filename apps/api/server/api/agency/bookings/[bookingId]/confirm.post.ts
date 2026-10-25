import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { confirmAgencyBooking } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Agency portal (v7 §10): confirm a held booking before its hold lapses; the receipt and its QR token are issued. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => confirmAgencyBooking(ctx, params.bookingId),
})
