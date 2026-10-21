import { z } from 'zod'
import { agencyUserPasswordSchema } from '@hajj/contracts/schemas/agency'
import { uuid } from '@hajj/contracts/schemas/common'
import { resetAgencyUserPassword } from '../../../../../services/accounts'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** A new password for an agency user who lost theirs (staff, `agency.manage`): every session of the user ends. */
export default defineApiHandler({
  params: z.object({ agencyId: uuid, userId: uuid }),
  body: agencyUserPasswordSchema,
  auth: 'required',
  handler: ({ ctx, params, body }) => resetAgencyUserPassword(ctx, params.agencyId, params.userId, body),
})
