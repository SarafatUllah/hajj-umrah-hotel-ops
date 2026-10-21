import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { listAgencyGuests } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Agency portal (v7 §7): the booking's pilgrim slots with the agency's own details (the read is logged). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => listAgencyGuests(ctx, params.bookingId),
})
