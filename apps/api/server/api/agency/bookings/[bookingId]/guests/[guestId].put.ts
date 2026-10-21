import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { saveAgencyGuest } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Agency portal (v7 §7, §13): enter or correct one pilgrim's details (by hand or from a passport scan's review form). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, guestId: uuid }),
  body: guestDetailsSchema,
  auth: 'agency',
  handler: ({ ctx, params, body }) => saveAgencyGuest(ctx, params.bookingId, params.guestId, body),
})
