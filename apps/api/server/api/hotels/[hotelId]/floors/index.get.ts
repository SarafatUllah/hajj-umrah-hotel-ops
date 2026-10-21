import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { listFloors } from '../../../../services/floorService'
import { listFloorsQuerySchema } from '@hajj/contracts/schemas/floor'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: listFloorsQuerySchema,
  handler: ({ ctx, params, query }) => listFloors(ctx, params.hotelId, query),
})
