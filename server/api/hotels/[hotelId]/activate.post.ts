import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { activateHotel } from '../../../services/hotelService'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  handler: ({ ctx, params }) => activateHotel(ctx, params.hotelId),
})
