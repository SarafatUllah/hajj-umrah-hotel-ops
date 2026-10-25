import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { quoteDeclineSchema } from '@hajj/contracts/schemas/quote'
import { declineQuote } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ quoteId: uuid }),
  body: quoteDeclineSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => declineQuote(ctx, params.quoteId, body),
})
