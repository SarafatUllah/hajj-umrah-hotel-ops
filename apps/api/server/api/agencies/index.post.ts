import { setResponseStatus } from 'h3'
import { createAgencySchema } from '@hajj/contracts/schemas/agency'
import { createAgency } from '../../services/accounts'
import { defineApiHandler } from '../../utils/apiHandler'

export default defineApiHandler({
  body: createAgencySchema,
  auth: 'required',
  handler: async ({ event, ctx, body }) => {
    const created = await createAgency(ctx, body)
    setResponseStatus(event, 201)
    return created
  },
})
