import { getBookingSettings } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

export default defineApiHandler({
  auth: 'required',
  handler: ({ ctx }) => getBookingSettings(ctx),
})
