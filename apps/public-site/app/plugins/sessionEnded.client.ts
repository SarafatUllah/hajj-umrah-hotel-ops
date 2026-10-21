/**
 * A call answered "your session is over" (the layer's `hajj:session-ended`): the visitor is signed out here too —
 * nothing of theirs stays cached — and sent to sign in, back to where they were afterwards.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('hajj:session-ended', async () => {
    useCustomerSession().customer.value = null
    nuxtApp.$queryClient.clear()
    const route = useRouter().currentRoute.value
    if (route.path !== '/sign-in') await navigateTo({ path: '/sign-in', query: { redirect: route.fullPath } })
  })
})
