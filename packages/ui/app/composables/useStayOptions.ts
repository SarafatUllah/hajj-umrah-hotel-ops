import { computed, ref, watch, type WatchSource } from 'vue'
import type { StaySearchResult } from '@hajj/contracts/types/booking'
import { toApiError } from '../utils/apiError'

/**
 * The options a stay search found and the one the booker chose (v7 §9): asking anything else (`asked` changes)
 * forgets both, and so does a conflict when acting on the option — its rooms went meanwhile, so search again.
 */
export function useStayOptions(asked: WatchSource | WatchSource[]) {
  const result = ref<StaySearchResult | null>(null)
  const chosen = ref<number | null>(null)
  const option = computed(() => (chosen.value === null ? undefined : result.value?.options[chosen.value]))

  function clear(): void {
    result.value = null
    chosen.value = null
  }
  watch(asked, clear, { deep: true })

  /** A new answer: nothing chosen yet, unless the caller already knows the only sensible choice. */
  function found(next: StaySearchResult, preselected: number | null = null): void {
    result.value = next
    chosen.value = preselected
  }

  /** Acting on the option failed: a 409 means the option no longer holds. */
  function failed(error: unknown): void {
    if (toApiError(error).status === 409) clear()
  }

  return { result, chosen, option, found, failed, clear }
}
