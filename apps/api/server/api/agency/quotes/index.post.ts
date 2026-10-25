import { setResponseStatus } from 'h3'
import { quoteRequestSchema } from '@hajj/contracts/schemas/quote'
import { requestQuote } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Agency portal: ask the price on WhatsApp — returns the quote (REQUESTED) and the click-to-chat link. */
export default defineApiHandler({
  body: quoteRequestSchema,
  auth: 'agency',
  handler: async ({ event, ctx, body }) => {
    const created = await requestQuote(ctx, body)
    setResponseStatus(event, 201)
    return created
  },
})
