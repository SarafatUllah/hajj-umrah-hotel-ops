import { setResponseStatus } from 'h3'
import { holdRequestSchema } from '@hajj/contracts/schemas/booking'
import { holdAgencyStay } from '../../../services/booking'
import { defineApiHandler } from '../../../utils/apiHandler'

/** Agency portal (v7 §10): hold the chosen option — the rooms are locked, checked again and held for the hold minutes. */
export default defineApiHandler({
  body: holdRequestSchema,
  auth: 'agency',
  handler: async ({ event, ctx, body }) => {
    const held = await holdAgencyStay(ctx, body)
    setResponseStatus(event, 201)
    return held
  },
})
