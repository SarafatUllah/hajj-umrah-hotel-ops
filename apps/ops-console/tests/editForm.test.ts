import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useEditForm } from '../app/composables/useEditForm'
import { useLastShown } from '../app/composables/useLastShown'

interface Saved { hold: number, request: number, version: number }
type Form = Omit<Saved, 'version'>
const formOf = ({ hold, request }: Saved): Form => ({ hold, request })
const changesOf = (form: Form, saved: Saved) => Object.fromEntries((Object.keys(form) as Array<keyof Form>).filter(key => form[key] !== saved[key]).map(key => [key, form[key]]))

describe('a form editing a saved record', () => {
  it('sends only this person\'s changes, even when the record reloads with someone else\'s meanwhile', async () => {
    // Arrange
    const saved = ref<Saved | undefined>({ hold: 10, request: 24, version: 1 })
    const { form, changes } = effectScope().run(() => useEditForm(() => saved.value, formOf, changesOf))!

    // Act: this person edits the hold; another admin's change to the request lands meanwhile
    form.value = { ...form.value!, hold: 15 }
    saved.value = { hold: 10, request: 36, version: 2 }
    await nextTick()

    // Assert: the edit stays, the other change is not sent back
    expect(form.value).toEqual({ hold: 15, request: 24 })
    expect(changes.value).toEqual({ hold: 15 })
  })

  it('follows a reload while nothing is edited, and starts again from what a save returned', async () => {
    const saved = ref<Saved | undefined>(undefined)
    const { form, changes, load } = effectScope().run(() => useEditForm(() => saved.value, formOf, changesOf))!
    expect(form.value).toBeNull()

    saved.value = { hold: 10, request: 24, version: 1 }
    await nextTick()
    expect(form.value).toEqual({ hold: 10, request: 24 })

    form.value = { hold: 15, request: 24 }
    load({ hold: 15, request: 24, version: 2 })
    expect(changes.value).toEqual({})
  })
})

describe('what a closing dialog keeps showing', () => {
  it('is the last value that was not null', async () => {
    const asked = ref<string | null>(null)
    const shown = effectScope().run(() => useLastShown(() => asked.value))!
    expect(shown.value).toBeNull()
    asked.value = 'rate 1'
    await nextTick()
    asked.value = null
    await nextTick()
    expect(shown.value).toBe('rate 1')
  })
})
