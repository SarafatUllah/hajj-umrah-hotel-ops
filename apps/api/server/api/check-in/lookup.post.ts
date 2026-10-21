import { checkInLookupSchema } from '@hajj/contracts/schemas/booking'
import { lookupReceipt } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

/** The desk scans a receipt's QR code (`booking.checkIn` on the booking's hotel); the token travels in the body, never the URL. */
export default defineApiHandler({
  body: checkInLookupSchema,
  auth: 'required',
  handler: ({ ctx, body }) => lookupReceipt(ctx, body),
})
