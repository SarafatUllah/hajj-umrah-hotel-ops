import { z } from 'zod'
import { BOOKING_RULE_KINDS } from '@hajj/contracts/schemas/bookingRules'
import { uuid } from '@hajj/contracts/schemas/common'
import { deleteBookingRule } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ hotelId: uuid, kind: z.enum(BOOKING_RULE_KINDS), ruleId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => deleteBookingRule(ctx, params.hotelId, params.kind, params.ruleId),
})
