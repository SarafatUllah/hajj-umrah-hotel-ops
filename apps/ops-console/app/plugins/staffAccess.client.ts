/** Answers meaning the staff member's rights may have changed since `me` was read (§6.4, §34). */
const RIGHTS_CHANGED: ReadonlySet<string> = new Set(['FORBIDDEN', 'HOTEL_NOT_FOUND'])

/**
 * The console's reactions to the API (`hajj:api-error`): two-factor setup now required → the setup page; a refused
 * action or a hotel gone from view → `me` is asked again, so the navigation and the buttons follow the new rights.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('hajj:api-error', async (error) => {
    if (error.code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') {
      await useStaffSession().refresh().catch(() => undefined)
      if (useRouter().currentRoute.value.path !== '/settings/two-factor') await navigateTo('/settings/two-factor')
      return
    }
    if (RIGHTS_CHANGED.has(error.code)) await useStaffSession().refresh().catch(() => undefined)
  })
})
