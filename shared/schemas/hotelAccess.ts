import { z } from 'zod'
import { uniqueIds } from './common'

/** DoS guard on the hotel-access request body; well above any realistic single-organization hotel count. */
const MAX_HOTELS_PER_ACCESS_GRANT = 200

export const hotelAccessBodySchema = z.object({
  allHotels: z.boolean(),
  hotelIds: uniqueIds(MAX_HOTELS_PER_ACCESS_GRANT, { required: false }),
}).strict()

export type HotelAccessBody = z.infer<typeof hotelAccessBodySchema>
