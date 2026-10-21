import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { guestDetailsSchema } from '@hajj/contracts/schemas/guest'
import { saveCustomerGuest } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Public site (v7 §7): enter or correct one pilgrim's details on the customer's own booking. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, guestId: uuid }),
  body: guestDetailsSchema,
  auth: 'customer',
  handler: ({ ctx, params, body }) => saveCustomerGuest(ctx, params.bookingId, params.guestId, body),
})
