import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { getRoomCalendar } from '../../../services/roomCalendarService'
import { roomCalendarQuerySchema } from '../../../../shared/schemas/roomCalendar'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: roomCalendarQuerySchema,
  handler: ({ ctx, params, query }) => getRoomCalendar(ctx, params.hotelId, query),
})
