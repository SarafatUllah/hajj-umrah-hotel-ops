import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { listHotelDocuments } from '../../../../services/documentService'
import { listDocumentsQuerySchema } from '../../../../../shared/schemas/document'
import { uuid } from '../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  query: listDocumentsQuerySchema,
  handler: ({ ctx, params, query }) => listHotelDocuments(ctx, params.hotelId, query),
})
