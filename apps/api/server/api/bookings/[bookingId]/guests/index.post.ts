import { z } from 'zod'
import { addGuestsSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { addGuests } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.edit`, v7 §12): add pilgrims to the booking in the rooms of the chosen option. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: addGuestsSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => addGuests(ctx, params.bookingId, body),
})
