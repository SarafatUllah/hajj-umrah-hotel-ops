import { toApiError } from '../utils/apiError'

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: Record<string, unknown> | FormData
  query?: Record<string, string | number | boolean | undefined>
}

/**
 * The API client of every frontend: same-origin `/api/…` (each app proxies it to the API, so the session cookie is
 * first-party), the caller's cookies forwarded during server rendering, and every failure turned into an `ApiError`.
 * Call it during setup (or in a route middleware): server rendering needs the request it runs for.
 */
type Fetcher = (url: string, options: ApiRequest) => Promise<unknown>

export function useApi() {
  // Nitro's route-typed fetch is too deep to compare: the client only needs a URL and options.
  const request: Fetcher = import.meta.server ? useRequestFetch() as unknown as Fetcher : $fetch as unknown as Fetcher
  return async function api<T>(path: string, options: ApiRequest = {}): Promise<T> {
    try {
      return await request(`/api${path}`, options) as T
    }
    catch (error) {
      throw toApiError(error)
    }
  }
}
