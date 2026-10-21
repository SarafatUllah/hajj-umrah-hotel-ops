import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { checkOutGuest } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Desk (`booking.checkIn`): checks one pilgrim out (v7 §12); when everyone has left or never came the booking is COMPLETED. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, guestId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => checkOutGuest(ctx, params.bookingId, params.guestId),
})
