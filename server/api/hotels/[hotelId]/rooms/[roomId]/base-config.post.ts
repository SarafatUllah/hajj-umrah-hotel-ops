import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { changeBaseConfig } from '../../../../../services/roomService'
import { changeBaseConfigSchema } from '../../../../../../shared/schemas/room'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  body: changeBaseConfigSchema,
  handler: ({ ctx, params, body }) => changeBaseConfig(ctx, params.hotelId, params.roomId, body),
})
