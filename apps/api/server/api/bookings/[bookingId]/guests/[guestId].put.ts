import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { saveGuest } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.edit`): enter or correct one pilgrim's details, e.g. at the reception on arrival (v7 §5 rule 16). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, guestId: uuid }),
  body: guestDetailsSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => saveGuest(ctx, params.bookingId, params.guestId, body),
})
