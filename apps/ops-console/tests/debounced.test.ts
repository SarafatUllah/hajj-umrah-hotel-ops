import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useDebounced } from '../app/composables/useDebounced'

describe('a value that waits for a pause', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('follows its source only once the changes stop', async () => {
    // Arrange
    const scope = effectScope()
    const source = ref('a')
    const settled = scope.run(() => useDebounced(source, 300))!

    // Act: three quick changes
    source.value = 'ab'
    await nextTick()
    vi.advanceTimersByTime(200)
    source.value = 'abc'
    await nextTick()
    vi.advanceTimersByTime(200)

    // Assert: still the first value, then the last one after the pause
    expect(settled.value).toBe('a')
    vi.advanceTimersByTime(100)
    expect(settled.value).toBe('abc')
    scope.stop()
  })

  it('drops a pending change when its owner goes away', async () => {
    const scope = effectScope()
    const source = ref(1)
    const settled = scope.run(() => useDebounced(source, 300))!
    source.value = 2
    await nextTick()
    scope.stop()
    vi.advanceTimersByTime(300)
    expect(settled.value).toBe(1)
  })
})
