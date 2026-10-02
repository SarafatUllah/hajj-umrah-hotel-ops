import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { listRoomBlocks } from '../../../../services/operationalBlockService'
import { listRoomBlocksQuerySchema } from '../../../../../shared/schemas/roomBlock'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: listRoomBlocksQuerySchema,
  handler: ({ ctx, params, query }) => listRoomBlocks(ctx, params.hotelId, query),
})
