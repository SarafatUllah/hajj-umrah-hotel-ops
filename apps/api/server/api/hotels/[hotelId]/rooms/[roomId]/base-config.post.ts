import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { changeBaseConfig } from '../../../../../services/roomService'
import { changeBaseConfigSchema } from '@hajj/contracts/schemas/room'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  body: changeBaseConfigSchema,
  handler: ({ ctx, params, body }) => changeBaseConfig(ctx, params.hotelId, params.roomId, body),
})
