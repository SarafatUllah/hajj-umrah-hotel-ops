/**
 * A call answered "your session is over" (`hajj:session-ended`): the visitor is signed out here too — nothing of
 * theirs stays cached — and sent to sign in, back to where they were afterwards.
 */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook('hajj:session-ended', async () => {
    usePrincipalSession().current.value = null
    nuxtApp.$queryClient.clear()
    const signInPath = useRuntimeConfig().public.session.signInPath
    const route = useRouter().currentRoute.value
    if (route.path !== signInPath) await navigateTo({ path: signInPath, query: { redirect: route.fullPath } })
  })
})
