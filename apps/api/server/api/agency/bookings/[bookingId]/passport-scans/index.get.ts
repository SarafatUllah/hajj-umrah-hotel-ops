import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { listAgencyScans } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Agency portal (v7 §13): the review cards of a booking's passport scans (the read is logged). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => listAgencyScans(ctx, params.bookingId),
})
