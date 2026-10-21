import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { uploadAgencyScan } from '../../../../../services/booking'
import { defineApiHandler } from '../../../../../utils/apiHandler'
import { readUploadForm } from '../../../../../utils/multipartUpload'

/** Agency portal (v7 §13): drop one passport photo (multipart `file`, PNG or JPEG); it is read in the background. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'agency',
  handler: async ({ event, ctx, params }) => {
    const form = await readUploadForm(event)
    const scan = await uploadAgencyScan(ctx, params.bookingId, form.file)
    setResponseStatus(event, 201)
    return scan
  },
})
