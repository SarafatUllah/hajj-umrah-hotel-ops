import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { getQuote } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ quoteId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => getQuote(ctx, params.quoteId),
})
