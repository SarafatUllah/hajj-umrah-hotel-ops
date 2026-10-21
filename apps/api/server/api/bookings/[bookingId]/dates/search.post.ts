import { z } from 'zod'
import { dateChangeSearchSchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { searchDateChange } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.edit`, v7 §12 date change): the options for the booking's pilgrims on new dates. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  body: dateChangeSearchSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => searchDateChange(ctx, params.bookingId, body),
})
