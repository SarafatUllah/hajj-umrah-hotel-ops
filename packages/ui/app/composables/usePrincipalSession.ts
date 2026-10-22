/**
 * Who is signed in to this app (a customer, an agency user, a staff member): `undefined` = not asked yet, `null` =
 * signed out. Each app names its endpoints in `runtimeConfig.public.session`; the server is asked once per visit and
 * after every sign-in or sign-out. Signing out also forgets every cached answer.
 */
export function usePrincipalSession<T>() {
  const paths = useRuntimeConfig().public.session
  const current = useState<T | null | undefined>('principal', () => undefined)
  const api = useApi()
  const { $queryClient } = useNuxtApp()

  async function refresh(): Promise<T | null> {
    try {
      current.value = await api<T>(paths.mePath)
    }
    catch (error) {
      if (toApiError(error).status !== 401) throw error
      current.value = null
    }
    return current.value
  }

  /** After a sign-in: nothing cached for whoever used this browser before shows to the one signing in. */
  function signedIn(principal: T): void {
    $queryClient.clear()
    current.value = principal
  }

  async function signOut(everywhere = false): Promise<void> {
    try {
      await api(everywhere && paths.signOutEverywherePath ? paths.signOutEverywherePath : paths.signOutPath, { method: 'POST' })
    }
    catch (error) {
      // A session that had already ended is signed out all the same.
      if (toApiError(error).status !== 401) throw error
    }
    current.value = null
    $queryClient.clear()
  }

  return {
    current,
    refresh,
    ensure: () => (current.value === undefined ? refresh() : Promise.resolve(current.value)),
    signedIn,
    signOut,
  }
}
