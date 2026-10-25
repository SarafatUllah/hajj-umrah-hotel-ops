import type { StaffMe } from '@hajj/contracts/types/staff'
import { defineApiHandler } from '../../utils/apiHandler'
import { getSessionContext } from '../../services/sessionContextService'

export default defineApiHandler({
  auth: 'required',
  // The client learns here that it must send the user to two-factor setup first.
  allowTwoFactorEnrollmentPending: true,
  handler: async ({ ctx }): Promise<StaffMe> => {
    const { organization, roles } = await getSessionContext(ctx)
    return {
      user: ctx.identity,
      organization,
      roles,
      permissions: Array.from(ctx.authz.permissions),
      allHotels: ctx.authz.allHotels,
      hotelIds: Array.from(ctx.authz.hotelIds),
      twoFactorEnrollmentRequired: ctx.twoFactorEnrollmentPending === true,
    }
  },
})
