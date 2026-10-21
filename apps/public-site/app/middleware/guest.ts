/** Sign-in is for visitors: a signed-in customer goes on to where they were heading. */
export default defineNuxtRouteMiddleware(async (to) => {
  const customer = await useCustomerSession().ensure().catch(() => undefined)
  if (customer) return navigateTo(safeRedirect(to.query.redirect))
})
