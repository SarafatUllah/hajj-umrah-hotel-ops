import { dehydrate, hydrate, MutationCache, QueryCache, QueryClient, type DehydratedState, VueQueryPlugin } from '@tanstack/vue-query'
import { toApiError } from '../utils/apiError'

/** A client error (4xx) is an answer, not a hiccup: retried never; no answer or a server error twice (in the browser). */
const MAX_RETRIES = 2
const STALE_MS = 30_000
/** The answers that mean the session is over (not a wrong code, which is also 401). */
const SESSION_ENDED: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'SESSION_INVALID'])

/**
 * Server data lives in TanStack Query (D3): cached by keys that include every parameter, refetched on focus, filled
 * during server rendering and handed to the browser with the page. One client per request on the server (this
 * plugin runs per request), without retries or garbage-collection timers there. Every failed call raises
 * `hajj:api-error` (an app reacts to the codes it cares about); one answered "session over" also raises
 * `hajj:session-ended`: the app signs its visitor out and sends them to sign in.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const state = useState<DehydratedState | null>('vue-query', () => null)
  const onError = (error: unknown) => {
    const apiError = toApiError(error)
    void nuxtApp.callHook('hajj:api-error', apiError)
    if (apiError.status === 401 && SESSION_ENDED.has(apiError.code)) void nuxtApp.callHook('hajj:session-ended')
  }
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        gcTime: import.meta.server ? Number.POSITIVE_INFINITY : undefined,
        retry: import.meta.server
          ? false
          : (failures, error) => {
              const { status, code } = toApiError(error)
              return (code === 'NETWORK' || status >= 500) && failures < MAX_RETRIES
            },
      },
      mutations: { retry: false },
    },
  })
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient })
  if (import.meta.server) nuxtApp.hooks.hook('app:rendered', () => { state.value = dehydrate(queryClient) })
  if (import.meta.client && state.value) hydrate(queryClient, state.value)
  // Provided so a sign-out can clear it: one person's cached data never shows to the next.
  return { provide: { queryClient } }
})
