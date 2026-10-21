import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { updateCapacityPeriod } from '../../../../../services/capacityPeriodService'
import { updateCapacityPeriodSchema } from '@hajj/contracts/schemas/capacityPeriod'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, periodId: uuid }),
  body: updateCapacityPeriodSchema,
  handler: ({ ctx, params, body }) => updateCapacityPeriod(ctx, params.hotelId, params.periodId, body),
})
