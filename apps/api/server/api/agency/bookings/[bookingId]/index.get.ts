import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { getAgencyBooking } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Agency portal: one of the agency's bookings — rooms, pilgrim-details progress, frozen price lines. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => getAgencyBooking(ctx, params.bookingId),
})
