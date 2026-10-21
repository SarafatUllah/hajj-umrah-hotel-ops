import { keepPreviousData } from '@tanstack/vue-query'
import type { OccupancyDayViewDto } from '@hajj/contracts/types/occupancy'

/**
 * One day of a hotel's occupancy (v7 §14: floors, rooms, the bookings sleeping there), for the calendar's day view
 * and the front desk's arrivals and departures — one query, so both read the same answer. Changes to a booking ask
 * it again (`['occupancy-day']`), as they do the calendar's ranges (`['occupancy']`).
 */
export function useOccupancyDay(hotelId: MaybeRefOrGetter<string>, date: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean>) {
  const api = useApi()
  return useApiQuery(
    () => ['occupancy-day', toValue(hotelId), toValue(date)],
    () => api<OccupancyDayViewDto>(`/hotels/${toValue(hotelId)}/occupancy/${toValue(date)}`),
    { enabled: computed(() => toValue(enabled) && !!toValue(date)), placeholderData: keepPreviousData },
  )
}
