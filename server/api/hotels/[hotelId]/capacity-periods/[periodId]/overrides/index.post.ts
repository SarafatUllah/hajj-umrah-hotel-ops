import { z } from 'zod'
import { defineApiHandler } from '../../../../../../utils/apiHandler'
import { applyOverrides } from '../../../../../../services/capacityPeriodService'
import { applyOverridesSchema } from '../../../../../../../shared/schemas/capacityPeriod'
import { uuid } from '../../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, periodId: uuid }),
  body: applyOverridesSchema,
  handler: ({ ctx, params, body }) => applyOverrides(ctx, params.hotelId, params.periodId, body),
})
