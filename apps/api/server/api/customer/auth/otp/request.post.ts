import { setResponseStatus } from 'h3'
import { otpRequestSchema } from '@hajj/contracts/schemas/customer'
import { requestCustomerOtp } from '../../../../services/accounts'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { clientIp } from '../../../../utils/clientIp'

/**
 * Public site: sends a sign-in code to a phone (SMS) or an e-mail address (D-P2-68). 202 whatever the destination;
 * 503 SMS_UNAVAILABLE / EMAIL_UNAVAILABLE while that channel has no provider.
 */
export default defineApiHandler({
  body: otpRequestSchema,
  handler: async ({ event, body }) => {
    const issued = await requestCustomerOtp(body, { clientIp: clientIp(event), now: new Date() })
    setResponseStatus(event, 202)
    return issued
  },
})
