import { z } from 'zod'
import { changeDatesSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { changeDates } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.edit`, v7 §12 date change): the whole booking moves to the new dates, or nothing changes. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: changeDatesSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => changeDates(ctx, params.bookingId, body),
})
