import type { FloorListItem, RoomTypeListItem } from '@hajj/contracts/types/hotel'

/** A hotel's active floors (for pickers and filters), cached with the floors page's own query. */
export function useFloors(hotelId: MaybeRefOrGetter<string>) {
  const api = useApi()
  const id = computed(() => toValue(hotelId))
  const query = useApiQuery(() => ['floors', id.value, false], () => api<FloorListItem[]>(`/hotels/${id.value}/floors`, { query: { includeInactive: 'false' } }), { enabled: computed(() => !!id.value) })
  const items = computed(() => (query.data.value ?? []).map(f => ({ value: f.id, label: f.label })))
  return { ...query, items }
}

/** The organization's active room types (for pickers and filters). */
export function useRoomTypes() {
  const api = useApi()
  const query = useApiQuery(['room-types', false], () => api<RoomTypeListItem[]>('/room-types', { query: { includeInactive: 'false' } }))
  const items = computed(() => (query.data.value ?? []).map(type => ({ value: type.id, label: type.name })))
  return { ...query, items, byId: (id: string) => query.data.value?.find(type => type.id === id) }
}
