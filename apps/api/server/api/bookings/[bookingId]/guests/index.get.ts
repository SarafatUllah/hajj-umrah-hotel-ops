import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { listGuestsQuerySchema } from '@hajj/contracts/schemas/guest'
import { listGuests } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console: the booking's pilgrim slots (`pilgrim.view`); `?reveal=passport` needs `pilgrim.viewSensitive` and is logged. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  query: listGuestsQuerySchema,
  auth: 'required',
  handler: ({ ctx, params, query }) => listGuests(ctx, params.bookingId, query),
})
