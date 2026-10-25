import { setResponseStatus } from 'h3'
import { staffHoldRequestSchema } from '@hajj/contracts/schemas/booking'
import { holdStayForAgency } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

/** Ops console (v7 §6): hold an option on an agency's behalf (`booking.create`); the booking is the agency's. */
export default defineApiHandler({
  body: staffHoldRequestSchema,
  auth: 'required',
  handler: async ({ event, ctx, body }) => {
    const held = await holdStayForAgency(ctx, body)
    setResponseStatus(event, 201)
    return held
  },
})
