import { z } from 'zod'
import { hotelTaskQuerySchema } from '@hajj/contracts/schemas/booking'
import { uuid } from '@hajj/contracts/schemas/common'
import { listHotelTasks } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Hotel panel (`booking.view`): housekeeping work the bookings created (v7 §11 extra beds), soonest due first. */
export default defineApiHandler({
  params: z.object({ hotelId: uuid }),
  query: hotelTaskQuerySchema,
  auth: 'required',
  handler: ({ ctx, params, query }) => listHotelTasks(ctx, params.hotelId, query),
})
