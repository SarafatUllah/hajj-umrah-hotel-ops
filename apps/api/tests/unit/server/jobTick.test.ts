import { describe, expect, it } from 'vitest'
import { isAuthorizedTick } from '../../../server/jobs/tickAuth'

const SECRET = 's'.repeat(40)

describe('isAuthorizedTick', () => {
  it('accepts exactly the configured secret as a bearer token', () => {
    expect(isAuthorizedTick(`Bearer ${SECRET}`, SECRET)).toBe(true)
  })

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the bare secret, no scheme', SECRET],
    ['another scheme', `Basic ${SECRET}`],
    ['a wrong secret of the same length', `Bearer ${'t'.repeat(40)}`],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, 20)}`],
    ['the secret with more after it', `Bearer ${SECRET}x`],
  ])('refuses %s', (_case, header) => {
    expect(isAuthorizedTick(header, SECRET)).toBe(false)
  })
})
