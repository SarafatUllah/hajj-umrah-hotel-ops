import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { agencyScanImage } from '../../../../../../services/booking'
import { defineApiHandler } from '../../../../../../utils/apiHandler'
import { sendPrivateImage } from '../../../../../../utils/privateImage'

/** Agency portal (v7 §13): the passport photo beside its review card (decrypted for this response only; logged). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, scanId: uuid }),
  auth: 'agency',
  handler: async ({ event, ctx, params }) => sendPrivateImage(event, await agencyScanImage(ctx, params.bookingId, params.scanId)),
})
