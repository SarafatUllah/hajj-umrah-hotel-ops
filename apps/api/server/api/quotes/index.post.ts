import { setResponseStatus } from 'h3'
import { staffQuoteCreateSchema } from '@hajj/contracts/schemas/quote'
import { createQuoteForAgency } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

export default defineApiHandler({
  body: staffQuoteCreateSchema,
  auth: 'required',
  handler: async ({ event, ctx, body }) => {
    const created = await createQuoteForAgency(ctx, body)
    setResponseStatus(event, 201)
    return created
  },
})
