import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { updateSettings } from '../../../services/hotelService'
import { updateSettingsSchema } from '@hajj/contracts/business-rules/hotelSettings'
import { uuid } from '@hajj/contracts/schemas/common'

export default defineApiHandler({
  auth: 'required',
  params: z.object({ hotelId: uuid }),
  body: updateSettingsSchema,
  handler: ({ ctx, params, body }) => updateSettings(ctx, params.hotelId, body),
})
