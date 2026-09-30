import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { deactivateFloor } from '../../../../../services/floorService'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, floorId: uuid }),
  handler: ({ ctx, params }) => deactivateFloor(ctx, params.hotelId, params.floorId),
})
