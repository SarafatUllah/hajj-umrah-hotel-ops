import { z } from 'zod'
import { guestAdditionSearchSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { searchGuestAdditions } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.edit`, v7 §12): where joining pilgrims can sleep — the booking's own rooms first. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: guestAdditionSearchSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => searchGuestAdditions(ctx, params.bookingId, body),
})
