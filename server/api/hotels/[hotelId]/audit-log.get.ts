import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { listHotelAudit } from '../../../services/hotelService'
import { listHotelAuditQuerySchema } from '../../../../shared/schemas/hotel'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: listHotelAuditQuerySchema,
  handler: ({ ctx, params, query }) => listHotelAudit(ctx, params.hotelId, query),
})
