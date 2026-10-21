import { describe, expect, it } from 'vitest'
import { heldWhile, typedHalalas, typedNumber, withSaved } from '../app/utils/forms'

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

describe('a number field', () => {
  it('a cleared one is nothing typed (the schema then says required); zero is a number', () => {
    expect([typedNumber(3), typedNumber(0), typedNumber(null), typedNumber(undefined), typedNumber(Number.NaN)]).toEqual([3, 0, undefined, undefined, undefined])
  })

  it('an amount typed in riyals is sent in halalas', () => {
    expect([typedHalalas(412.5), typedHalalas(0), typedHalalas(null)]).toEqual([41250, 0, undefined])
  })
})
