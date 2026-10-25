import { staySearchSchema } from '@hajj/contracts/schemas/booking'
import { searchAgencyStay } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Agency portal (v7 §9): the room options for a stay, priced. Nothing is held until an option is chosen. */
export default defineApiHandler({
  body: staySearchSchema,
  auth: 'agency',
  handler: ({ ctx, body }) => searchAgencyStay(ctx, body),
})
