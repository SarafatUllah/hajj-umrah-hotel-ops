import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { getAgency } from '../../../services/accounts'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ agencyId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => getAgency(ctx, params.agencyId),
})
