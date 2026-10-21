import { z } from 'zod'
import { updateAgencyUserSchema } from '@hajj/contracts/schemas/agency'
import { uuid } from '@hajj/contracts/schemas/common'
import { updateAgencyUser } from '../../../../services/accounts'
import { defineApiHandler } from '../../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ agencyId: uuid, userId: uuid }),
  body: updateAgencyUserSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => updateAgencyUser(ctx, params.agencyId, params.userId, body),
})
