import { z } from 'zod'
import { BOOKING_RULE_KINDS } from '@hajj/contracts/schemas/bookingRules'
import { uuid } from '@hajj/contracts/schemas/common'
import { updateBookingRule } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ hotelId: uuid, kind: z.enum(BOOKING_RULE_KINDS), ruleId: uuid }),
  body: z.record(z.unknown()),
  auth: 'required',
  handler: ({ ctx, params, body }) => updateBookingRule(ctx, params.hotelId, params.kind, params.ruleId, body),
})
