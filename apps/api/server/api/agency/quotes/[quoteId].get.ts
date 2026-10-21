import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { getAgencyQuote } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ quoteId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => getAgencyQuote(ctx, params.quoteId),
})
