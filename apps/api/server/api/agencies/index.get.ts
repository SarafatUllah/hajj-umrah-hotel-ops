import { listAgenciesQuerySchema } from '@hajj/contracts/schemas/agency'
import { listAgencies } from '../../services/accounts'
import { defineApiHandler } from '../../utils/apiHandler'

export default defineApiHandler({
  query: listAgenciesQuerySchema,
  auth: 'required',
  handler: ({ ctx, query }) => listAgencies(ctx, query),
})
