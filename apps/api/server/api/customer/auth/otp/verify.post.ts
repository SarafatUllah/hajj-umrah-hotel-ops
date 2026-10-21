import { otpVerifySchema } from '@hajj/contracts/schemas/customer'
import { verifyCustomerOtp } from '../../../../services/accounts'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { clientIp } from '../../../../utils/clientIp'

/** Public site: a correct code signs the customer in (creating the account on first use). */
export default defineApiHandler({
  body: otpVerifySchema,
  handler: async ({ event, body }) => {
    const user = await verifyCustomerOtp(body, { clientIp: clientIp(event), now: new Date() })
    await replaceUserSession(event, {
      user: { id: user.id, organizationId: user.organizationId, fullName: user.fullName, kind: 'customer', sessionVersion: user.sessionVersion },
      loggedInAt: Date.now(),
    })
    return { customer: { id: user.id, phone: user.phone, fullName: user.fullName }, isNew: user.isNew }
  },
})
