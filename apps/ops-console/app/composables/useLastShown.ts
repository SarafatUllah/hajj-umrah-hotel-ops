import { type Ref, shallowRef, watch } from 'vue'

/** The last value `source` gave that was not null: a dialog or drawer keeps its words while it closes (no empty title mid-animation). */
export function useLastShown<T>(source: () => T | null): Readonly<Ref<T | null>> {
  const last = shallowRef<T | null>(source())
  watch(source, (value) => { if (value !== null) last.value = value })
  return last
}
