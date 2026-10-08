import { defineApiHandler } from '../../utils/apiHandler'
import { getSessionContext } from '../../services/sessionContextService'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ ctx }) => {
    const { organization, roles } = await getSessionContext(ctx)
    return {
      user: ctx.identity,
      organization,
      roles,
      permissions: Array.from(ctx.authz.permissions),
      allHotels: ctx.authz.allHotels,
      hotelIds: Array.from(ctx.authz.hotelIds),
    }
  },
})
