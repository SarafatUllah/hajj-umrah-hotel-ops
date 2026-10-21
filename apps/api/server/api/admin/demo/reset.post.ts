import { z } from 'zod'
import { defineApiHandler } from '../../../utils/apiHandler'
import { requireOrgPermission } from '../../../security/authorize'
import { resetDemoData, DemoOrganizationNotFoundError, DemoResetForbiddenError, DemoSeedForbiddenError } from '../../../services/demo.service'
import { ForbiddenError, NotFoundError } from '../../../errors/domainError'
import { isValidDemoAnchorDate } from '../../../demo/catalog'

/** Optional, strict body: only a real ISO `anchorDate` inside the supported demo window; any other field is rejected (422). */
const resetBodySchema = z.object({
  anchorDate: z.string().refine(isValidDemoAnchorDate, { message: 'Invalid date (expected a real YYYY-MM-DD between 2000-01-01 and 2100-12-31)' }).optional(),
}).strict().optional()

export default defineApiHandler({
  auth: 'required',
  body: resetBodySchema,
  handler: async ({ ctx, body }) => {
    requireOrgPermission(ctx, 'organization.resetDemo')
    try {
      // The permission check above is necessary but not sufficient: every org's SUPER_ADMIN in the
      // demo organization holds organization.resetDemo (least privilege, PF-2 — only the demo org's
      // SUPER_ADMIN, never any other tenant's), so the service also verifies the caller belongs to
      // the demo organization itself as a second layer.
      return await resetDemoData({ userId: ctx.identity.userId, organizationId: ctx.identity.organizationId }, { anchorDate: body?.anchorDate })
    }
    catch (error) {
      if (error instanceof DemoResetForbiddenError) throw new ForbiddenError('FORBIDDEN')
      if (error instanceof DemoOrganizationNotFoundError) throw new NotFoundError('DEMO_ORGANIZATION_NOT_FOUND')
      if (error instanceof DemoSeedForbiddenError) throw new ForbiddenError('DEMO_SEED_NOT_ALLOWED')
      throw error
    }
  },
})
