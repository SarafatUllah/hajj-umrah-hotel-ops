import { setResponseStatus } from 'h3'
import { defineApiHandler } from '../../utils/apiHandler'
import { createRoomType } from '../../services/roomTypeService'
import { createRoomTypeSchema } from '@hajj/contracts/schemas/roomType'

export default defineApiHandler({
  auth: 'required',
  body: createRoomTypeSchema,
  handler: async ({ ctx, body, event }) => {
    const created = await createRoomType(ctx, body)
    setResponseStatus(event, 201)
    return created
  },
})
