/** Pages open before two-factor setup is done (sign-in, and the setup itself). */
const OPEN_DURING_ENROLLMENT = ['/login', '/settings/two-factor']

/**
 * A staff member whose role requires two-factor authentication and who has not set it up may do nothing else (the
 * API answers 403 elsewhere): every page sends them to the setup first.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (OPEN_DURING_ENROLLMENT.includes(to.path)) return
  const me = await useStaffSession().ensure().catch(() => undefined)
  if (me?.twoFactorEnrollmentRequired) return navigateTo('/settings/two-factor')
})
