import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { completeHotelTask } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Hotel panel (`booking.checkIn`: reception): a housekeeping task is done. */
export default defineApiHandler({
  params: z.object({ hotelId: uuid, taskId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => completeHotelTask(ctx, params.hotelId, params.taskId),
})
