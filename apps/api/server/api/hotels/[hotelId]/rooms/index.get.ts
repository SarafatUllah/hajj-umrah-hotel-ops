import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { listRooms } from '../../../../services/roomService'
import { listRoomsQuerySchema } from '@hajj/contracts/schemas/room'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: listRoomsQuerySchema,
  handler: ({ ctx, params, query }) => listRooms(ctx, params.hotelId, query),
})
