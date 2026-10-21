import { z } from 'zod'
import { defineApiHandler } from '../../../../../../utils/apiHandler'
import { removeOverrides } from '../../../../../../services/capacityPeriodService'
import { removeOverridesSchema } from '@hajj/contracts/schemas/capacityPeriod'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, periodId: uuid }),
  body: removeOverridesSchema,
  handler: ({ ctx, params, body }) => removeOverrides(ctx, params.hotelId, params.periodId, body),
})
