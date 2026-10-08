import { z } from 'zod'
import { defineApiHandler } from '../../../../../../utils/apiHandler'
import { removeOverrides } from '../../../../../../services/capacityPeriodService'
import { removeOverridesSchema } from '../../../../../../../shared/schemas/capacityPeriod'
import { uuid } from '../../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, periodId: uuid }),
  body: removeOverridesSchema,
  handler: ({ ctx, params, body }) => removeOverrides(ctx, params.hotelId, params.periodId, body),
})
