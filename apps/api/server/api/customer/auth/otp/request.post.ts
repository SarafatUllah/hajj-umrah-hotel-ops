import { setResponseStatus } from 'h3'
import { otpRequestSchema } from '@hajj/contracts/schemas/customer'
import { requestCustomerOtp } from '../../../../services/accounts'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { clientIp } from '../../../../utils/clientIp'

/** Public site: texts a sign-in code. 202 whatever the phone; 503 SMS_UNAVAILABLE while no SMS gateway is configured. */
export default defineApiHandler({
  body: otpRequestSchema,
  handler: async ({ event, body }) => {
    const issued = await requestCustomerOtp(body, { clientIp: clientIp(event), now: new Date() })
    setResponseStatus(event, 202)
    return issued
  },
})
