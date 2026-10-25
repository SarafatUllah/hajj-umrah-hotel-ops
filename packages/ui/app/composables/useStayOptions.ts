import { computed, ref, watch, type WatchSource } from 'vue'
import type { StaySearchResult } from '@hajj/contracts/types/booking'
import { toApiError } from '../utils/apiError'

/**
 * The options a stay search found and the one the booker chose (v7 §9): asking anything else (`asked` changes)
 * forgets both, and so does a conflict when acting on the option — its rooms went meanwhile, so search again. Each
 * search takes the current `question()` along and hands it back with its answer: an answer to an earlier question
 * (the form changed while it was asked) is dropped, never shown against the new form.
 */
export function useStayOptions(asked: WatchSource | WatchSource[]) {
  const result = ref<StaySearchResult | null>(null)
  const chosen = ref<number | null>(null)
  const option = computed(() => (chosen.value === null ? undefined : result.value?.options[chosen.value]))
  let generation = 0

  function clear(): void {
    result.value = null
    chosen.value = null
  }
  watch(asked, () => {
    generation += 1
    clear()
  }, { deep: true })

  /** What is asked now (pass it to the search and back to `found`). */
  const question = (): number => generation

  /** A new answer: nothing chosen yet, unless the caller already knows the only sensible choice. */
  function found(next: StaySearchResult, preselected: number | null = null, askedAs: number = generation): void {
    if (askedAs !== generation) return
    result.value = next
    chosen.value = preselected
  }

  /** Acting on the option failed: a 409 means the option no longer holds. */
  function failed(error: unknown): void {
    if (toApiError(error).status === 409) clear()
  }

  return { result, chosen, option, found, failed, clear, question }
}
