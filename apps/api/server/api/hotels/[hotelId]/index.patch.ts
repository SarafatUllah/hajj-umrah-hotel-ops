import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { updateHotel } from '../../../services/hotelService'
import { updateHotelSchema } from '../../../../shared/schemas/hotel'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: updateHotelSchema,
  handler: ({ ctx, params, body }) => updateHotel(ctx, params.hotelId, body),
})
