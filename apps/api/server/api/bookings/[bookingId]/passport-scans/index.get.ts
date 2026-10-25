import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { listScans } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.edit`): the review cards of a booking's passport scans (the read is logged). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => listScans(ctx, params.bookingId),
})
