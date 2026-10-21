import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { updateFloor } from '../../../../../services/floorService'
import { updateFloorSchema } from '../../../../../../shared/schemas/floor'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, floorId: uuid }),
  body: updateFloorSchema,
  handler: ({ ctx, params, body }) => updateFloor(ctx, params.hotelId, params.floorId, body),
})
