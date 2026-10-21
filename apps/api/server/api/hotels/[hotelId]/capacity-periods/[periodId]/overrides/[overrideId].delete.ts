import { z } from 'zod'
import { defineApiHandler } from '../../../../../../utils/apiHandler'
import { deleteOverride } from '../../../../../../services/capacityPeriodService'
import { uuid } from '../../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, periodId: uuid, overrideId: uuid }),
  handler: ({ ctx, params }) => deleteOverride(ctx, params.hotelId, params.periodId, params.overrideId),
})
