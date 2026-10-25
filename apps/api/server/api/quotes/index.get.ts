import { listQuotesQuerySchema } from '@hajj/contracts/schemas/quote'
import { listQuotes } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

export default defineApiHandler({
  query: listQuotesQuerySchema,
  auth: 'required',
  handler: ({ ctx, query }) => listQuotes(ctx, query),
})
