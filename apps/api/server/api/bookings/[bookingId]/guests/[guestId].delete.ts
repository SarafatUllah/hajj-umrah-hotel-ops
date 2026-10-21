import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { removeGuest } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'

/** Ops console (`booking.cancel`, v7 §12): take a pilgrim off the booking; their seat is free at once. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, guestId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => removeGuest(ctx, params.bookingId, params.guestId),
})
