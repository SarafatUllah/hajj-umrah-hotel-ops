import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { listCustomerGuests } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Public site: the booking's pilgrims, passport numbers masked. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'customer',
  handler: ({ ctx, params }) => listCustomerGuests(ctx, params.bookingId),
})
