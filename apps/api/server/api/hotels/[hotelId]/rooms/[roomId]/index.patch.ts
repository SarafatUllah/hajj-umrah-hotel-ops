import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { updateRoom } from '../../../../../services/roomService'
import { updateRoomSchema } from '../../../../../../shared/schemas/room'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  body: updateRoomSchema,
  handler: ({ ctx, params, body }) => updateRoom(ctx, params.hotelId, params.roomId, body),
})
