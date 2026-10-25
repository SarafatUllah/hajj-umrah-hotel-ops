/** Sign-in (and registration) are for visitors: a signed-in principal goes on to where they were heading. */
export default defineNuxtRouteMiddleware(async (to) => {
  const principal = await usePrincipalSession().ensure().catch(() => undefined)
  if (principal) return navigateTo(safeRedirect(to.query.redirect, useRuntimeConfig().public.session.homePath))
})
