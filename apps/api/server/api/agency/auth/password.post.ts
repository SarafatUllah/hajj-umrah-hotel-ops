import { agencyPasswordChangeSchema } from '@hajj/contracts/schemas/agency'
import { changeAgencyPassword } from '../../../services/accounts'
import { defineApiHandler } from '../../../utils/apiHandler'

/**
 * The signed-in agency user's own new password (whatever the agency's status): every session of theirs ends, and
 * this one is renewed with the new session version so the user stays signed in here.
 */
export default defineApiHandler({
  body: agencyPasswordChangeSchema,
  auth: 'agency-any-status',
  handler: async ({ event, ctx, body }) => {
    const user = await changeAgencyPassword(ctx, body)
    await replaceUserSession(event, {
      user: { id: user.id, organizationId: user.organizationId, email: user.email, fullName: user.fullName, kind: 'agency', agencyId: user.agencyId, sessionVersion: user.sessionVersion },
      loggedInAt: Date.now(),
    })
    return { success: true }
  },
})
