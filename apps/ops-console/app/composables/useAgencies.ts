import type { AgencyListPage } from '@hajj/contracts/types/agency'

/** The most agencies one list holds (the API's largest page): an organization works with far fewer. */
const AGENCY_PAGE = 100

/**
 * The organization's agencies (staff with `agency.view`) for filters and pickers: every agency for a filter, only
 * the approved ones to book for (an agency that is not approved gets no price, v7 §15).
 */
export function useAgencies(enabled: MaybeRefOrGetter<boolean>) {
  const api = useApi()
  const query = useApiQuery(['agencies', 'picker'], () => api<AgencyListPage>('/agencies', { query: { pageSize: AGENCY_PAGE } }), { enabled: computed(() => toValue(enabled)) })
  const items = computed(() => (query.data.value?.items ?? []).map(a => ({ value: a.id, label: a.name })))
  const approved = computed(() => (query.data.value?.items ?? []).filter(a => a.status === 'APPROVED').map(a => ({ value: a.id, label: a.name })))
  return { ...query, items, approved }
}
