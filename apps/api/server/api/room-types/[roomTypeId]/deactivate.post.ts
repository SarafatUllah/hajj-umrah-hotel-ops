import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { deactivateRoomType } from '../../../services/roomTypeService'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ roomTypeId: uuid }),
  handler: ({ ctx, params }) => deactivateRoomType(ctx, params.roomTypeId),
})
