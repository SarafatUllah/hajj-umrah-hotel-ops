import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { checkInGuest } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'

/** Desk (`booking.checkIn`): checks one pilgrim in (v7 §12): full details first, on a day of the stay; the first arrival makes the booking IN_HOUSE. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid, guestId: uuid }),
  auth: 'required',
  handler: ({ ctx, params }) => checkInGuest(ctx, params.bookingId, params.guestId),
})
