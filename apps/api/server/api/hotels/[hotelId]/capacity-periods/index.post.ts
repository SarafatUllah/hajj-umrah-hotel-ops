import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { createCapacityPeriod } from '../../../../services/capacityPeriodService'
import { createCapacityPeriodSchema } from '@hajj/contracts/schemas/capacityPeriod'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: createCapacityPeriodSchema,
  handler: async ({ ctx, params, body, event }) => {
    const created = await createCapacityPeriod(ctx, params.hotelId, body)
    setResponseStatus(event, 201)
    return created
  },
})
