import { z } from 'zod'
import { moveGuestsSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { moveGuests } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.edit`, v7 §12 room move): these pilgrims sleep in another room from a night on. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: moveGuestsSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => moveGuests(ctx, params.bookingId, body),
})
