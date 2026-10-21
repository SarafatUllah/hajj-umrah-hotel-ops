import { listQuotesQuerySchema } from '@hajj/contracts/schemas/quote'
import { listAgencyQuotes } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  query: listQuotesQuerySchema,
  auth: 'agency',
  handler: ({ ctx, query }) => listAgencyQuotes(ctx, query),
})
