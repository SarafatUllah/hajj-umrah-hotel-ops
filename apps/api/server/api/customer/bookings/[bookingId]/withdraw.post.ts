import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { withdrawCustomerRequest } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Public site (v7 §10): withdraw an open request; its rooms are free at once (a confirmed booking: ask the hotel). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'customer',
  handler: ({ ctx, params }) => withdrawCustomerRequest(ctx, params.bookingId),
})
