import type { PublicHotel } from '@hajj/contracts/types/hotel'

/** The operator's active hotels (the same list as the public site), with their names for selects and labels. */
export function useHotels() {
  const api = useApi()
  const organization = useRuntimeConfig().public.organizationSlug
  const query = useApiQuery(['public-hotels', organization], () => api<PublicHotel[]>('/public/hotels', { query: { organization } }))
  const items = computed(() => (query.data.value ?? []).map(h => ({ value: h.id, label: `${h.name} · ${h.city}` })))
  const nameOf = (hotelId: string) => query.data.value?.find(h => h.id === hotelId)?.name ?? ''
  return { ...query, items, nameOf }
}
