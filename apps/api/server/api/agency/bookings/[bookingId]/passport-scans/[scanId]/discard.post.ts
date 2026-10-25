import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { discardAgencyScan } from '../../../../../../services/booking'
import { defineApiHandler } from '../../../../../../utils/apiHandler'

/** Agency portal: throw a scan away (a wrong or unreadable photo); its image is deleted at once. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, scanId: uuid }),
  auth: 'agency',
  handler: ({ ctx, params }) => discardAgencyScan(ctx, params.bookingId, params.scanId),
})
