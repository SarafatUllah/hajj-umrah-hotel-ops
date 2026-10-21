import { describe, expect, it } from 'vitest'
import { isMaskedPassport, maskPassport } from '@hajj/contracts/utils/passport'

describe('a passport number shown masked (v7 §13)', () => {
  it('keeps the last three characters (two of a short number), and is known as masked', () => {
    expect(maskPassport('A1234567')).toBe('•••567')
    expect(maskPassport('A1234')).toBe('•••34')
    expect(isMaskedPassport(maskPassport('A1234567'))).toBe(true)
    expect([isMaskedPassport('A1234567'), isMaskedPassport(null), isMaskedPassport('')]).toEqual([false, false, false])
  })
})
