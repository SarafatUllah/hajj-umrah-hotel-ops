import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { updateRoomType } from '../../../services/roomTypeService'
import { updateRoomTypeSchema } from '@hajj/contracts/schemas/roomType'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ roomTypeId: uuid }),
  body: updateRoomTypeSchema,
  handler: ({ ctx, params, body }) => updateRoomType(ctx, params.roomTypeId, body),
})
