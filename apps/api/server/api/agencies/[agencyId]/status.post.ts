import { z } from 'zod'
import { agencyStatusChangeSchema } from '@hajj/contracts/schemas/agency'
import { uuid } from '@hajj/contracts/schemas/common'
import { changeAgencyStatus } from '../../../services/accounts'
import { defineApiHandler } from '../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ agencyId: uuid }),
  body: agencyStatusChangeSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => changeAgencyStatus(ctx, params.agencyId, body),
})
