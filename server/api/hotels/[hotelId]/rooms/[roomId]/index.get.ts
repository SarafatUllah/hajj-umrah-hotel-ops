import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { getRoom } from '../../../../../services/roomService'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  handler: ({ ctx, params }) => getRoom(ctx, params.hotelId, params.roomId),
})
