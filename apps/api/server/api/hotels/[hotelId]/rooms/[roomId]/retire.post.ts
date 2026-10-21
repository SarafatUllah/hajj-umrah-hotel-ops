import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { retireRoom } from '../../../../../services/roomService'
import { retireRoomSchema } from '@hajj/contracts/schemas/room'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  body: retireRoomSchema,
  handler: ({ ctx, params, body }) => retireRoom(ctx, params.hotelId, params.roomId, body),
})
