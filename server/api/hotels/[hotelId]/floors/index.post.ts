import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { createFloor } from '../../../../services/floorService'
import { createFloorSchema } from '../../../../../shared/schemas/floor'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: createFloorSchema,
  handler: async ({ ctx, params, body, event }) => {
    const created = await createFloor(ctx, params.hotelId, body)
    setResponseStatus(event, 201)
    return created
  },
})
