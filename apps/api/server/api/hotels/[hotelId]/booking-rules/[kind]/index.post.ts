import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { BOOKING_RULE_KINDS } from '@hajj/contracts/schemas/bookingRules'
import { uuid } from '@hajj/contracts/schemas/common'
import { createBookingRule } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** The body is validated by the service with the kind's own schema (422 VALIDATION_FAILED like every route). */
export default defineApiHandler({
  params: z.object({ hotelId: uuid, kind: z.enum(BOOKING_RULE_KINDS) }),
  body: z.unknown(),
  auth: 'required',
  handler: async ({ event, ctx, params, body }) => {
    const created = await createBookingRule(ctx, params.hotelId, params.kind, body)
    setResponseStatus(event, 201)
    return created
  },
})
