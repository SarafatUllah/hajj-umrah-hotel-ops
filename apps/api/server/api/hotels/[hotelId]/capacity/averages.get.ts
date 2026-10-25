import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { getHotelAverages } from '../../../../services/capacityAverageService'
import { hotelAveragesQuerySchema } from '@hajj/contracts/schemas/capacityAverages'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: hotelAveragesQuerySchema,
  handler: ({ ctx, params, query }) => getHotelAverages(ctx, params.hotelId, query),
})
