/** Pages of a signed-in customer: anyone signed out signs in first and comes back. */
export default defineNuxtRouteMiddleware(async (to) => {
  // Unknown (the API did not answer): the page loads, and its own requests show the error with Retry.
  const customer = await useCustomerSession().ensure().catch(() => undefined)
  if (customer === null) return navigateTo({ path: '/sign-in', query: { redirect: to.fullPath } })
})
