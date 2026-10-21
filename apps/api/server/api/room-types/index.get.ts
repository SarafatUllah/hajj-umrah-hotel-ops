import { defineApiHandler } from '../../utils/apiHandler'
import { listRoomTypes } from '../../services/roomTypeService'
import { listRoomTypesQuerySchema } from '@hajj/contracts/schemas/roomType'

export default defineApiHandler({
  auth: 'required',
  query: listRoomTypesQuerySchema,
  handler: ({ ctx, query }) => listRoomTypes(ctx, query),
})
