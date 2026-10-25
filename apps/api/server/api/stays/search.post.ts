import { staffStaySearchSchema } from '@hajj/contracts/schemas/booking'
import { searchStayForAgency } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

/** Ops console (v7 §6): a seller or manager searches room options on an agency's behalf (`booking.create`). */
export default defineApiHandler({
  body: staffStaySearchSchema,
  auth: 'required',
  handler: ({ ctx, body }) => searchStayForAgency(ctx, body),
})
