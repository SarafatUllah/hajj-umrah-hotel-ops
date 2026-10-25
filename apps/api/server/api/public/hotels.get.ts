import { publicHotelsQuerySchema } from '@hajj/contracts/schemas/hotel'
import { listPublicHotels } from '../../services/hotelService'
import { clientIp } from '../../utils/clientIp'
import { useDb } from '../../utils/db'
import { defineApiHandler } from '../../utils/apiHandler'

/** Public site (unauthenticated): the organization's active hotels, to choose where to stay. */
export default defineApiHandler({
  query: publicHotelsQuerySchema,
  handler: ({ event, query }) => listPublicHotels(useDb(), query.organization, { clientIp: clientIp(event), now: new Date() }),
})
