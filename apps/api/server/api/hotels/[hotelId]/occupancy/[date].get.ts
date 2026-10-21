import { z } from 'zod'
import { isoDate, uuid } from '@hajj/contracts/schemas/common'
import { getOccupancyDay } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Hotel panel (`occupancy.view`, v7 §14 day view): floors → rooms → bookings and pilgrims on one night. */
export default defineApiHandler({
  params: z.object({ hotelId: uuid, date: isoDate }),
  auth: 'required',
  handler: ({ ctx, params }) => getOccupancyDay(ctx, params.hotelId, params.date),
})
