import type { HotelSummary } from '@hajj/contracts/types/hotel'

/**
 * The hotels this staff member can see (`GET /api/hotels`, sorted by name; the API never returns others): the switcher,
 * the hotel chooser and every hotel picker read this one cached list. Hotels appear in URLs by their code (D4).
 */
export function useHotels() {
  const api = useApi()
  const query = useApiQuery(['hotels'], () => api<HotelSummary[]>('/hotels'))
  const items = computed(() => query.data.value ?? [])
  return {
    ...query,
    items,
    byCode: (code: string | null | undefined) => (code ? items.value.find(h => h.code === code) : undefined),
    byId: (id: string | null | undefined) => (id ? items.value.find(h => h.id === id) : undefined),
  }
}
