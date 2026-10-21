import { computed, type Ref, ref, shallowRef, watch } from 'vue'

/**
 * A form editing a saved record: built from it, built again when the record reloads only while nothing is being
 * edited (unsaved changes stay), and its changes always measured against the version it was built from — so a
 * reload meanwhile (someone else's change) is never sent back as if it were this person's. `load(saved)` after a save.
 */
export function useEditForm<Saved, Form, Changes extends object>(saved: () => Saved | undefined, formOf: (saved: Saved) => Form, changesOf: (form: Form, saved: Saved) => Changes) {
  const form = ref(null) as Ref<Form | null>
  const base = shallowRef<Saved>()
  /** The changes of a form state against the version it was built from (none before one loads). */
  const changesFrom = (state: Form): Changes | Record<string, never> => (base.value === undefined ? {} : changesOf(state, base.value))
  const changes = computed(() => (form.value === null ? {} : changesFrom(form.value)))
  function load(record: Saved): void {
    base.value = record
    form.value = formOf(record)
  }
  watch(saved, (loaded) => {
    if (loaded !== undefined && Object.keys(changes.value).length === 0) load(loaded)
  }, { immediate: true })
  return { form, changes, changesFrom, load }
}
