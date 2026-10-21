import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { quoteOfferSchema } from '@hajj/contracts/schemas/quote'
import { offerQuote } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ quoteId: uuid }),
  body: quoteOfferSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => offerQuote(ctx, params.quoteId, body),
})
