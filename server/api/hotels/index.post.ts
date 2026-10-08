import { setResponseStatus } from 'h3'
import { defineApiHandler } from '../../utils/apiHandler'
import { createHotel } from '../../services/hotelService'
import { createHotelSchema } from '../../../shared/schemas/hotel'

export default defineApiHandler({
  auth: 'required',
  body: createHotelSchema,
  handler: async ({ ctx, body, event }) => {
    const created = await createHotel(ctx, body)
    setResponseStatus(event, 201)
    return created
  },
})
