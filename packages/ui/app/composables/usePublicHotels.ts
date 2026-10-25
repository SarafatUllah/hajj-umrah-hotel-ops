import type { PublicHotel } from '@hajj/contracts/types/hotel'

/**
 * The operator's active hotels as the public sees them (`/api/public/hotels` of the app's organization: the agency
 * portal and the public site), with their names for selects and labels.
 */
export function usePublicHotels() {
  const api = useApi()
  const organization = String(useRuntimeConfig().public.organizationSlug)
  const query = useApiQuery(['public-hotels', organization], () => api<PublicHotel[]>('/public/hotels', { query: { organization } }))
  const items = computed(() => (query.data.value ?? []).map(h => ({ value: h.id, label: `${h.name} · ${h.city}` })))
  const nameOf = (hotelId: string) => query.data.value?.find(h => h.id === hotelId)?.name ?? ''
  return { ...query, items, nameOf }
}
