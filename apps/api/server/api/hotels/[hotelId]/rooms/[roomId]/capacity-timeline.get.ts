import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { getRoomCapacityTimeline } from '../../../../../services/capacityPeriodService'
import { capacityTimelineQuerySchema } from '@hajj/contracts/schemas/capacityPeriod'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  query: capacityTimelineQuerySchema,
  handler: ({ ctx, params, query }) => getRoomCapacityTimeline(ctx, params.hotelId, params.roomId, query),
})
