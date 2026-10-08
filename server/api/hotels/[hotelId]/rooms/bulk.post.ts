import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { bulkCreateRooms } from '../../../../services/roomService'
import { bulkCreateRoomsSchema } from '../../../../../shared/schemas/room'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: bulkCreateRoomsSchema,
  handler: async ({ ctx, params, body, event }) => {
    const created = await bulkCreateRooms(ctx, params.hotelId, body)
    setResponseStatus(event, 201)
    return created
  },
})
