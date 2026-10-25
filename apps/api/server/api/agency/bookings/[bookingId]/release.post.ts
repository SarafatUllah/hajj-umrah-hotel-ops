import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { releaseAgencyHold } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Agency portal (v7 §12): let go of a hold before confirming it; the seats are free at once (a confirmed booking: ask the hotel). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => releaseAgencyHold(ctx, params.bookingId),
})
