import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { confirmScan } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Ops console (`booking.edit`, v7 §13 steps 4–5): confirm the (corrected) review form of a scan into a slot. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, scanId: uuid }),
  body: z.object({ guestId: uuid, details: guestDetailsSchema }).strict(),
  auth: 'required',
  handler: ({ ctx, params, body }) => confirmScan(ctx, params.bookingId, params.scanId, body),
})
