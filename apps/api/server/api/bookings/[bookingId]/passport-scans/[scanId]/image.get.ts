import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { scanImage } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { sendPrivateImage } from '../../../../../utils/privateImage'

/** Ops console (`booking.edit`): the passport photo beside its review card (logged). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, scanId: uuid }),
  auth: 'required',
  handler: async ({ event, ctx, params }) => sendPrivateImage(event, await scanImage(ctx, params.bookingId, params.scanId)),
})
