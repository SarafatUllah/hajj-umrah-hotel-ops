import { z } from 'zod'
import { addGuestsSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { addAgencyGuests } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Agency portal (v7 §12): add pilgrims to its own booking in the rooms of the chosen option. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: addGuestsSchema,
  auth: 'agency',
  handler: ({ ctx, params, body }) => addAgencyGuests(ctx, params.bookingId, body),
})
