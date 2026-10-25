/**
 * The hotel suspended (or has not approved) the agency while it was signed in: a call answers
 * `AGENCY_NOT_APPROVED`, so the portal asks who it is again and shows where the agency stands.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('hajj:api-error', async (error) => {
    if (error.code !== 'AGENCY_NOT_APPROVED') return
    await useAgencySession().refresh().catch(() => undefined)
    if (useRouter().currentRoute.value.path !== '/pending') await navigateTo('/pending')
  })
})
