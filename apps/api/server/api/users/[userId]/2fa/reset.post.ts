import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { twoFactorResetSchema } from '@hajj/contracts/schemas/auth'
import { resetTwoFactor } from '../../../../services/twoFactorService'
import { defineApiHandler } from '../../../../utils/apiHandler'

export default defineApiHandler({
  params: z.object({ userId: uuid }),
  body: twoFactorResetSchema,
  auth: 'required',
  handler: async ({ ctx, params, body }) => {
    await resetTwoFactor(ctx, params.userId, body.reason)
    return { reset: true }
  },
})
