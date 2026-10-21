import { z } from 'zod'
import { guestAdditionSearchSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { searchAgencyGuestAdditions } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Agency portal (v7 §12: agencies add pilgrims themselves): where joining pilgrims can sleep — its own rooms first. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: guestAdditionSearchSchema,
  auth: 'agency',
  handler: ({ ctx, params, body }) => searchAgencyGuestAdditions(ctx, params.bookingId, body),
})
