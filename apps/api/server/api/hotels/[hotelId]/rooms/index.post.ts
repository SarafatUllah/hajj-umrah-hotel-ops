import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { createRoom } from '../../../../services/roomService'
import { createRoomSchema } from '../../../../../shared/schemas/room'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: createRoomSchema,
  handler: async ({ ctx, params, body, event }) => {
    const created = await createRoom(ctx, params.hotelId, body)
    setResponseStatus(event, 201)
    return created
  },
})
