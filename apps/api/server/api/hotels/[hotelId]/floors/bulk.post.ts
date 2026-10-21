import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { bulkCreateFloors } from '../../../../services/floorService'
import { bulkCreateFloorsSchema } from '../../../../../shared/schemas/floor'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: bulkCreateFloorsSchema,
  handler: async ({ ctx, params, body, event }) => {
    const created = await bulkCreateFloors(ctx, params.hotelId, body)
    setResponseStatus(event, 201)
    return created
  },
})
