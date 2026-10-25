import { z } from 'zod'
import { BOOKING_RULE_KINDS } from '@hajj/contracts/schemas/bookingRules'
import { uuid } from '@hajj/contracts/schemas/common'
import { listBookingRules } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** `kind`: rates | agency-quotas | allocation-rules | extra-bed-policies (v7 §15). */
export default defineApiHandler({
  params: z.object({ hotelId: uuid, kind: z.enum(BOOKING_RULE_KINDS) }),
  auth: 'required',
  handler: ({ ctx, params }) => listBookingRules(ctx, params.hotelId, params.kind),
})
