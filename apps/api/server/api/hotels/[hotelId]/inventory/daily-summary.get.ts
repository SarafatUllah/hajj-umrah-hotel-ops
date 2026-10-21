import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { getDailySummary } from '../../../../services/roomCalendarService'
import { dailySummaryQuerySchema } from '../../../../../shared/schemas/roomCalendar'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: dailySummaryQuerySchema,
  handler: ({ ctx, params, query }) => getDailySummary(ctx, params.hotelId, query),
})
