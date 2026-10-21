import { SEARCH_DELAY_MS, useDebounced } from './useDebounced'

/** A list's page as the URL gives it: from 1 (a missing, zero, negative or broken one is the first). */
export const pageNumber = (raw: string | undefined): number => Math.max(1, Math.trunc(Number(raw ?? 1)) || 1)

/**
 * A page's view kept in its URL query (filters, page, the open item): read a value, change several at once (an empty
 * value leaves the URL), and a search box that writes to the URL after a pause in typing and follows the URL when it
 * changes elsewhere (back, "clear filters"), and a list's page.
 */
export function useUrlQuery() {
  const route = useRoute()
  const router = useRouter()
  const queryOf = (name: string): string | undefined => (typeof route.query[name] === 'string' ? route.query[name] as string : undefined)
  // Changes asked for while an earlier one is still navigating are merged into it, never lost.
  let pending: Record<string, string | undefined> = {}
  let navigation = 0
  function setQuery(changes: Record<string, string | undefined>): void {
    pending = { ...pending, ...changes }
    const next = { ...router.currentRoute.value.query, ...pending }
    const id = ++navigation
    void router.replace({ query: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== '')) })
      .finally(() => { if (id === navigation) pending = {} })
  }
  /** The box for `name`; `alongside` is written with it (a new search starts again on page 1). */
  function searchOf(name: string, alongside: Record<string, string | undefined> = {}): Ref<string> {
    const term = ref(queryOf(name) ?? '')
    const settled = useDebounced(term, SEARCH_DELAY_MS)
    // What this box last wrote: the URL catching up with it is not a change made elsewhere (keys typed meanwhile stay).
    let written: string | null = null
    watch(settled, (value) => {
      const next = value.trim() || undefined
      if (next === queryOf(name)) return
      written = next ?? ''
      setQuery({ [name]: next, ...alongside })
    })
    watch(() => queryOf(name) ?? '', (value) => {
      if (value === written) {
        written = null
        return
      }
      if (value !== term.value.trim()) term.value = value
    })
    return term
  }
  /** A list's page (`page`; the first leaves the URL). */
  function pageOf(): WritableComputedRef<number> {
    return computed({
      get: () => pageNumber(queryOf('page')),
      set: (value: number) => setQuery({ page: value === 1 ? undefined : String(value) }),
    })
  }
  return { queryOf, setQuery, searchOf, pageOf }
}
