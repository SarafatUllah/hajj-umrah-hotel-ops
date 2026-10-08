import { sendStream, setResponseHeaders } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { attachmentDisposition } from '../../../../../utils/contentDisposition'
import { downloadHotelDocument } from '../../../../../services/documentService'
import { downloadDocumentQuerySchema } from '../../../../../../shared/schemas/document'
import { uuid } from '../../../../../../shared/schemas/common'

// Streams the stored bytes through the API after authorization (no public URL, no redirect).
export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid, documentId: uuid }),
  query: downloadDocumentQuerySchema,
  handler: async ({ event, ctx, params, query }) => {
    const file = await downloadHotelDocument(ctx, params.hotelId, params.documentId, { includeArchived: query.includeArchived })
    // A client that goes away mid-download must not leave the file descriptor open.
    event.node.res.once('close', () => file.stream.destroy())
    setResponseHeaders(event, {
      'Content-Type': file.mimeType,
      'Content-Length': String(file.sizeBytes),
      'Content-Disposition': attachmentDisposition(file.filename),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': 'default-src \'none\'; sandbox',
    })
    return sendStream(event, file.stream)
  },
})
