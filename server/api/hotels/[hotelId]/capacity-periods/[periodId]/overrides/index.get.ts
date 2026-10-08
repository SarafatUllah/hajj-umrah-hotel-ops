import { z } from 'zod'
import { defineApiHandler } from '../../../../../../utils/apiHandler'
import { listOverrides } from '../../../../../../services/capacityPeriodService'
import { uuid } from '../../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, periodId: uuid }),
  handler: ({ ctx, params }) => listOverrides(ctx, params.hotelId, params.periodId),
})
