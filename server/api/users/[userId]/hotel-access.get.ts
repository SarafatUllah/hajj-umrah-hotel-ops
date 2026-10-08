import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { getUserHotelAccess } from '../../../services/hotelAccessService'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  params: z.object({ userId: uuid }),
  auth: 'required',
  handler: async ({ ctx, params }) => getUserHotelAccess(ctx, params.userId),
})
