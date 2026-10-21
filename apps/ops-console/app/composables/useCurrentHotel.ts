import type { HotelSummary } from '@hajj/contracts/types/hotel'

/**
 * The hotel of a hotel's page (`/hotels/:hotel/...`, by its code): `hotel` once known, `unknown` when the code
 * matches none of the hotels this user can see — the same answer for "no such hotel" and "no access" (§6.4).
 */
export function useCurrentHotel() {
  const { hotels, current } = useHotelScope()
  const hotel = computed<HotelSummary | undefined>(() => current.value)
  const hotelId = computed(() => hotel.value?.id ?? '')
  const unknown = computed(() => !!hotels.data.value && !hotel.value)
  const isInactive = computed(() => hotel.value?.status === 'INACTIVE')
  return { hotels, hotel, hotelId, unknown, isInactive, ready: computed(() => !!hotel.value) }
}
