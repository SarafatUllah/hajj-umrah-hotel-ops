import { describe, expect, it } from 'vitest'
import { normalizeEmail } from '../../../shared/utils/email'

describe('normalizeEmail', () => {
  it('lowercases the address', () => {
    expect(normalizeEmail('Admin@Demo.AlSafaHotels.TEST')).toBe('admin@demo.alsafahotels.test')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com')
  })

  it('leaves an already-normalized address unchanged', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com')
  })
})
