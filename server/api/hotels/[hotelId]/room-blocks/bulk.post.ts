import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { bulkCreateRoomBlocks } from '../../../../services/operationalBlockService'
import { bulkCreateRoomBlocksSchema } from '../../../../../shared/schemas/roomBlock'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: bulkCreateRoomBlocksSchema,
  handler: async ({ ctx, params, body, event }) => {
    const created = await bulkCreateRoomBlocks(ctx, params.hotelId, body)
    setResponseStatus(event, 201)
    return created
  },
})
