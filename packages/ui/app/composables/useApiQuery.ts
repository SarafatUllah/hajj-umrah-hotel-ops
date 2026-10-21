import { type QueryKey, useQuery, type UseQueryOptions } from '@tanstack/vue-query'

/**
 * A query of server data (D3) that is also fetched during server rendering: the page arrives with its data, and the
 * browser takes over the cache. The key must name every parameter of the request. A failure renders as the page's
 * error state (never a 500 page); a query not enabled yet is left to the browser.
 */
export function useApiQuery<T>(key: MaybeRefOrGetter<QueryKey>, fetcher: () => Promise<T>, options: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'> = {}) {
  const query = useQuery({ throwOnError: false, ...options, queryKey: computed(() => toValue(key)), queryFn: fetcher } as UseQueryOptions<T>)
  onServerPrefetch(async () => {
    if (toValue((options as { enabled?: MaybeRefOrGetter<boolean | undefined> }).enabled) === false) return
    await query.suspense()
  })
  return query
}
