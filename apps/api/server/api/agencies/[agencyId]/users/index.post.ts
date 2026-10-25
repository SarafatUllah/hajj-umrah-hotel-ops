import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { createAgencyUserSchema } from '@hajj/contracts/schemas/agency'
import { uuid } from '@hajj/contracts/schemas/common'
import { addAgencyUser } from '../../../../services/accounts'
import { defineApiHandler } from '../../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ agencyId: uuid }),
  body: createAgencyUserSchema,
  auth: 'required',
  handler: async ({ event, ctx, params, body }) => {
    const created = await addAgencyUser(ctx, params.agencyId, body)
    setResponseStatus(event, 201)
    return created
  },
})
