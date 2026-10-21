import { setResponseStatus } from 'h3'
import { agencyRegistrationSchema } from '@hajj/contracts/schemas/agency'
import { registerAgency } from '../../services/accounts'
import { defineApiHandler } from '../../utils/apiHandler'
import { clientIp } from '../../utils/clientIp'

/**
 * Agency portal, public: registers an agency (PENDING until staff approve it) and its first user. Always 202
 * with the same body, whether or not the licence or e-mail was already known (no enumeration).
 */
export default defineApiHandler({
  body: agencyRegistrationSchema,
  handler: async ({ event, body }) => {
    const result = await registerAgency(body, { clientIp: clientIp(event), now: new Date() })
    setResponseStatus(event, 202)
    return result
  },
})
