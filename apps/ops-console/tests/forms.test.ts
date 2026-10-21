import { describe, expect, it } from 'vitest'
import { heldWhile, withSaved } from '../app/utils/forms'

describe('a drawer while its save runs', () => {
  it('cannot be dismissed until the answer, and can again after', () => {
    expect(heldWhile(true)).toEqual({ dismissible: false, close: { disabled: true } })
    expect(heldWhile(false)).toEqual({ dismissible: true, close: { disabled: false } })
  })
})

describe('the choices of a saved field', () => {
  const active = [{ value: 'f1', label: 'Floor 1' }]

  it('keep the saved one when it has since been deactivated', () => {
    expect(withSaved(active, { value: 'f9', label: 'Old wing' })).toEqual([...active, { value: 'f9', label: 'Old wing' }])
  })

  it('are only the active ones when the saved one is among them, or there is none', () => {
    expect(withSaved(active, { value: 'f1', label: 'Floor 1' })).toEqual(active)
    expect(withSaved(active, null)).toEqual(active)
  })
})
