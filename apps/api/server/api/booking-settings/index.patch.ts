import { bookingSettingsPatchSchema } from '@hajj/contracts/schemas/bookingRules'
import { updateBookingSettings } from '../../services/booking'
import { defineApiHandler } from '../../utils/apiHandler'

export default defineApiHandler({
  body: bookingSettingsPatchSchema,
  auth: 'required',
  handler: ({ ctx, body }) => updateBookingSettings(ctx, body),
})
