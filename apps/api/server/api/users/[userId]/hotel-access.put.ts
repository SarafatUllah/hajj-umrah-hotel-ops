import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { setUserHotelAccess } from '../../../services/hotelAccessService'
import { hotelAccessBodySchema } from '@hajj/contracts/schemas/hotelAccess'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  params: z.object({ userId: uuid }),
  body: hotelAccessBodySchema,
  auth: 'required',
  handler: async ({ ctx, params, body }) => setUserHotelAccess(ctx, params.userId, body),
})
