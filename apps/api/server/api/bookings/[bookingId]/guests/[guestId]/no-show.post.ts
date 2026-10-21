import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { markGuestNoShow } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Desk (`booking.checkIn`): records that a pilgrim never came (v7 §12, from the check-in day on); the seat stays booked (release: step 14). */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, guestId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => markGuestNoShow(ctx, params.bookingId, params.guestId),
})
