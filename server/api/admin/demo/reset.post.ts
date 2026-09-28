import { defineApiHandler } from '../../../utils/apiHandler'
import { requireOrgPermission } from '../../../security/authorize'
import { resetDemoData, DemoOrganizationNotFoundError, DemoResetForbiddenError } from '../../../services/demo.service'
import { ForbiddenError, NotFoundError } from '../../../errors/domainError'

export default defineApiHandler({
  auth: 'required',
  handler: async ({ ctx }) => {
    requireOrgPermission(ctx, 'organization.resetDemo')
    try {
      // The permission check above is necessary but not sufficient: every org's SUPER_ADMIN in the
      // demo organization holds organization.resetDemo (least privilege, PF-2 — only the demo org's
      // SUPER_ADMIN, never any other tenant's), so the service also verifies the caller belongs to
      // the demo organization itself as a second layer.
      return await resetDemoData({ userId: ctx.identity.userId, organizationId: ctx.identity.organizationId })
    }
    catch (error) {
      if (error instanceof DemoResetForbiddenError) throw new ForbiddenError('FORBIDDEN')
      if (error instanceof DemoOrganizationNotFoundError) throw new NotFoundError('DEMO_ORGANIZATION_NOT_FOUND')
      throw error
    }
  },
})
