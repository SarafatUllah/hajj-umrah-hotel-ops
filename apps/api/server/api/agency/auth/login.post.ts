import { agencyLoginSchema } from '@hajj/contracts/schemas/agency'
import { UnauthenticatedError } from '../../../errors/domainError'
import { loginAgencyUser } from '../../../services/accounts'
import { defineApiHandler } from '../../../utils/apiHandler'
import { clientIp } from '../../../utils/clientIp'

export default defineApiHandler({
  body: agencyLoginSchema,
  handler: async ({ event, body }) => {
    const user = await loginAgencyUser(body, { clientIp: clientIp(event), now: new Date() })
    // One answer for an unknown organization, an unknown e-mail and a wrong password.
    if (!user) throw new UnauthenticatedError('INVALID_CREDENTIALS', 'Invalid organization, email, or password')

    await replaceUserSession(event, {
      user: { id: user.id, organizationId: user.organizationId, email: user.email, fullName: user.fullName, kind: 'agency', agencyId: user.agencyId, sessionVersion: user.sessionVersion },
      loggedInAt: Date.now(),
    })
    return { user: { id: user.id, agencyId: user.agencyId, email: user.email, fullName: user.fullName } }
  },
})
