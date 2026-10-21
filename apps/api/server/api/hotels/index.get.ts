import { defineApiHandler } from '../../utils/apiHandler'
import { listHotels } from '../../services/hotelService'

export default defineApiHandler({
  auth: 'required',
  handler: ({ ctx }) => listHotels(ctx),
})
