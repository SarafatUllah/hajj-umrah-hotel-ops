import { useQueryClient } from '@tanstack/vue-query'

/**
 * After a write to a hotel, everything shown of it is asked again: every query keyed by the hotel (its detail,
 * floors, figures, seasons, documents, history…) and the lists across hotels (the hotels, the averages). Writes never
 * patch the cache by hand (§39).
 */
export function useHotelRefresh() {
  const queryClient = useQueryClient()
  return (hotelId: string) => Promise.all([
    queryClient.invalidateQueries({ predicate: query => query.queryKey.includes(hotelId) }),
    queryClient.invalidateQueries({ queryKey: ['hotels'] }),
    queryClient.invalidateQueries({ queryKey: ['capacity-averages'] }),
  ])
}
