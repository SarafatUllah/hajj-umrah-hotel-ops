import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { listRooms } from '../../../../services/roomService'
import { listRoomsQuerySchema } from '../../../../../shared/schemas/room'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: listRoomsQuerySchema,
  handler: ({ ctx, params, query }) => listRooms(ctx, params.hotelId, query),
})
