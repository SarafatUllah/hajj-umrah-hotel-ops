import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { reactivateRoom } from '../../../../../services/roomService'
import { reactivateRoomSchema } from '../../../../../../shared/schemas/room'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  body: reactivateRoomSchema,
  handler: ({ ctx, params, body }) => reactivateRoom(ctx, params.hotelId, params.roomId, body),
})
