import { resetDemoData, DemoOrganizationNotFoundError, DemoResetForbiddenError } from '../../../services/demo.service'

export default defineEventHandler(async (event) => {
  const session = await requirePermission(event, 'organization.resetDemo')
  try {
    // The permission check above is necessary but not sufficient: every
    // org's SUPER_ADMIN holds organization.resetDemo, so the service also
    // verifies the caller belongs to the demo organization itself.
    return await resetDemoData({ userId: session.user!.id, organizationId: session.user!.organizationId })
  }
  catch (error) {
    if (error instanceof DemoResetForbiddenError) {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
    }
    if (error instanceof DemoOrganizationNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: 'Demo organization not found' })
    }
    throw error
  }
})
