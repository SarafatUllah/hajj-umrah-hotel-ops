import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { updateSettings } from '../../../services/hotelService'
import { updateSettingsSchema } from '../../../../shared/business-rules/hotelSettings'
import { uuid } from '../../../../shared/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: updateSettingsSchema,
  handler: ({ ctx, params, body }) => updateSettings(ctx, params.hotelId, body),
})
