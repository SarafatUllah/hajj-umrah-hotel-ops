import { type MaybeRefOrGetter, onScopeDispose, type Ref, readonly, ref, toValue, watch } from 'vue'

/** How long a search box waits after the last key before it asks. */
export const SEARCH_DELAY_MS = 300

/** `source`, a moment after it stops changing: a search that asks only once typing pauses, a preview of a form. */
export function useDebounced<T>(source: MaybeRefOrGetter<T>, delayMs: number): Readonly<Ref<T>> {
  const settled = ref(toValue(source)) as Ref<T>
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(() => toValue(source), (value) => {
    clearTimeout(timer)
    timer = setTimeout(() => { settled.value = value }, delayMs)
  })
  onScopeDispose(() => clearTimeout(timer))
  return readonly(settled) as Readonly<Ref<T>>
}
