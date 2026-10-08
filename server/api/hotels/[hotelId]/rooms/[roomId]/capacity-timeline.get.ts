import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { getRoomCapacityTimeline } from '../../../../../services/capacityPeriodService'
import { capacityTimelineQuerySchema } from '../../../../../../shared/schemas/capacityPeriod'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, roomId: uuid }),
  query: capacityTimelineQuerySchema,
  handler: ({ ctx, params, query }) => getRoomCapacityTimeline(ctx, params.hotelId, params.roomId, query),
})
