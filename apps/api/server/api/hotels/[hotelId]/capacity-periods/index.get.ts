import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { listCapacityPeriods } from '../../../../services/capacityPeriodService'
import { listCapacityPeriodsQuerySchema } from '../../../../../shared/schemas/capacityPeriod'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: listCapacityPeriodsQuerySchema,
  handler: ({ ctx, params, query }) => listCapacityPeriods(ctx, params.hotelId, query),
})
