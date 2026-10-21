import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { createRoomBlock } from '../../../../../services/operationalBlockService'
import { createRoomBlockSchema } from '../../../../../../shared/schemas/roomBlock'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  body: createRoomBlockSchema,
  handler: async ({ ctx, params, body, event }) => {
    const created = await createRoomBlock(ctx, params.hotelId, params.roomId, body)
    setResponseStatus(event, 201)
    return created
  },
})
