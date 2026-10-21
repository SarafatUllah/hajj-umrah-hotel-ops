import { defineApiHandler } from '../../utils/apiHandler'
import { getOrganizationAverages } from '../../services/capacityAverageService'
import { organizationAveragesQuerySchema } from '@hajj/contracts/schemas/capacityAverages'

export default defineApiHandler({
  auth: 'required',
  query: organizationAveragesQuerySchema,
  handler: ({ ctx, query }) => getOrganizationAverages(ctx, query),
})
