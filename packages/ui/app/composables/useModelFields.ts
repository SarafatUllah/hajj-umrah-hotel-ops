import { computed, type Ref, watch } from 'vue'

/**
 * The fields of an object `v-model` (a form's state), each read from it and written as a new value of the whole —
 * never changed in place. Writes made before the parent re-renders build on each other, so autofill filling several
 * fields at once keeps every one of them. `normalize` shapes what is written (e.g. upper case).
 */
export function useModelFields<T extends object>(model: Ref<T>) {
  let latest = model.value
  watch(model, (value) => { latest = value })
  return function field<K extends keyof T>(key: K, normalize: (value: T[K]) => T[K] = value => value) {
    return computed({
      get: () => model.value[key],
      set: (value: T[K]) => {
        latest = { ...latest, [key]: normalize(value) }
        model.value = latest
      },
    })
  }
}
