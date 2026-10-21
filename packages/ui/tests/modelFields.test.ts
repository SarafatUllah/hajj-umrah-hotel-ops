import { describe, expect, it } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { useModelFields } from '../app/composables/useModelFields'

/** A `defineModel` ref: reads the parent's value; a write reaches the parent only when it re-renders (later). */
function parentModel<T>(initial: T) {
  const parent = ref(initial)
  const model = computed({ get: () => parent.value, set: (value: T) => { void Promise.resolve().then(() => { parent.value = value }) } })
  return { parent, model }
}

describe('the fields of an object v-model', () => {
  it('several fields written before the parent re-renders (autofill) all arrive, as a new value of the whole', async () => {
    const { parent, model } = parentModel({ name: '', city: '', code: '' })
    const original = parent.value
    const field = useModelFields(model)
    field('name').value = 'Quba'
    field('city').value = 'Madinah'
    field('code').value = 'MED-QUBA'
    await nextTick()
    expect(parent.value).toEqual({ name: 'Quba', city: 'Madinah', code: 'MED-QUBA' })
    expect(original).toEqual({ name: '', city: '', code: '' })
  })

  it('a field reads the current value and can normalize what is written', async () => {
    const { parent, model } = parentModel({ code: '' })
    const code = useModelFields(model)('code', value => value.toUpperCase())
    code.value = 'med-quba'
    await nextTick()
    expect(code.value).toBe('MED-QUBA')
    parent.value = { code: 'MKK-GRAND' }
    expect(code.value).toBe('MKK-GRAND')
  })
})
