import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { readUploadForm } from '../../../../utils/multipartUpload'
import { assertCanUploadDocument, uploadHotelDocument } from '../../../../services/documentService'
import { uuid } from '../../../../../shared/schemas/common'

// multipart/form-data: `file` (the binary part) + text fields docType, title, description?. No `body`
// schema here — defineApiHandler's JSON body reader is not for multipart; the fields are validated by
// the service (uploadDocumentFieldsSchema).
export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  handler: async ({ event, ctx, params }) => {
    // Refuse an unauthorized caller before the (up to ~10 MB) body is read into memory.
    await assertCanUploadDocument(ctx, params.hotelId)
    const form = await readUploadForm(event)
    const created = await uploadHotelDocument(ctx, params.hotelId, { fields: form.fields, file: form.file })
    setResponseStatus(event, 201)
    return created
  },
})
