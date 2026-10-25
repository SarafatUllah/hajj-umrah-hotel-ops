import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { discardScan } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Ops console (`booking.edit`): throw a scan away; its image is deleted at once. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, scanId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => discardScan(ctx, params.bookingId, params.scanId),
})
