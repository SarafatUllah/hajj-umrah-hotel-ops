import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { cancelRoomBlock } from '../../../../../services/operationalBlockService'
import { cancelRoomBlockSchema } from '../../../../../../shared/schemas/roomBlock'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, blockId: uuid }),
  body: cancelRoomBlockSchema,
  handler: ({ ctx, params, body }) => cancelRoomBlock(ctx, params.hotelId, params.blockId, body),
})
