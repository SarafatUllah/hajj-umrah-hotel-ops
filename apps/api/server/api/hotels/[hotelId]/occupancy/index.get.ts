import { z } from 'zod'
import { dateRange, uuid } from '@hajj/contracts/schemas/common'
import { getOccupancy } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Hotel panel (`occupancy.view`, v7 §14 year and month views): per day of `from…to` (≤ 400 days) the rooms, seats and movements. */
export default defineApiHandler({
  params: z.object({ hotelId: uuid }),
  query: dateRange,
  auth: 'required',
  handler: ({ ctx, params, query }) => getOccupancy(ctx, params.hotelId, query),
})
