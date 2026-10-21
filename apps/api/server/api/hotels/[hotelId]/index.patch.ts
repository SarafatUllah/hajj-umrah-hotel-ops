import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { updateHotel } from '../../../services/hotelService'
import { updateHotelSchema } from '@hajj/contracts/schemas/hotel'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: updateHotelSchema,
  handler: ({ ctx, params, body }) => updateHotel(ctx, params.hotelId, body),
})
