import { defineApiHandler } from '../../utils/apiHandler'
import { getOrganizationAverages } from '../../services/capacityAverageService'
import { organizationAveragesQuerySchema } from '../../../shared/schemas/capacityAverages'

export default defineApiHandler({
  auth: 'required',
  query: organizationAveragesQuerySchema,
  handler: ({ ctx, query }) => getOrganizationAverages(ctx, query),
})
