import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { activateRoomType } from '../../../services/roomTypeService'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ roomTypeId: uuid }),
  handler: ({ ctx, params }) => activateRoomType(ctx, params.roomTypeId),
})
