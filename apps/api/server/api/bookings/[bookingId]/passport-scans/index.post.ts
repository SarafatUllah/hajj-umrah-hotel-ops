import { setResponseStatus } from 'h3'
import { z } from 'zod'
import { uuid } from '@hajj/contracts/schemas/common'
import { uploadScan } from '../../../../services/booking'
import { defineApiHandler } from '../../../../utils/apiHandler'
import { readUploadForm } from '../../../../utils/multipartUpload'

/** Ops console (`booking.edit`, e.g. reception with the phone camera): one passport photo, read in the background. */
export default defineApiHandler({
  params: z.object({ bookingId: uuid }),
  auth: 'required',
  handler: async ({ event, ctx, params }) => {
    const form = await readUploadForm(event)
    const scan = await uploadScan(ctx, params.bookingId, form.file)
    setResponseStatus(event, 201)
    return scan
  },
})
