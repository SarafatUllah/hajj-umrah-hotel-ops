/** Pages of a signed-in principal: anyone signed out signs in first and comes back. */
export default defineNuxtRouteMiddleware(async (to) => {
  // Unknown (the API did not answer): the page loads, and its own requests show the error with Retry.
  const principal = await usePrincipalSession().ensure().catch(() => undefined)
  if (principal === null) return navigateTo({ path: useRuntimeConfig().public.session.signInPath, query: { redirect: to.fullPath } })
})
