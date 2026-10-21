import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { confirmAgencyScan } from '../../../../../../services/booking'
import { defineApiHandler } from '../../../../../../utils/apiHandler'

/** Agency portal (v7 §13 steps 4–5): confirm the (corrected) review form of a scan into a slot. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, scanId: uuid }),
  body: z.object({ guestId: uuid, details: guestDetailsSchema }).strict(),
  auth: 'agency',
  handler: ({ ctx, params, body }) => confirmAgencyScan(ctx, params.bookingId, params.scanId, body),
})
