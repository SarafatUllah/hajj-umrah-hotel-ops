import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { getSettings } from '../../../services/hotelService'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  handler: ({ ctx, params }) => getSettings(ctx, params.hotelId),
})
