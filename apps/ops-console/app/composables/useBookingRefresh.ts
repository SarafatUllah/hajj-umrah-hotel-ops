import { useQueryClient } from '@tanstack/vue-query'
import { bookingChangeKeys } from '../utils/booking'

/** Asks again everything a booking's change shows in (`bookingChangeKeys`): after a hold, a confirmation, any change. */
export function useBookingRefresh() {
  const queryClient = useQueryClient()
  return (bookingId?: string) => Promise.all(bookingChangeKeys(bookingId).map(queryKey => queryClient.invalidateQueries({ queryKey })))
}
