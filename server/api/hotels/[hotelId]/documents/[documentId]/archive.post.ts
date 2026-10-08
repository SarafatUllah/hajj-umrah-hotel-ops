import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { archiveHotelDocument } from '../../../../../services/documentService'
import { uuid } from '../../../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, documentId: uuid }),
  handler: ({ ctx, params }) => archiveHotelDocument(ctx, params.hotelId, params.documentId),
})
