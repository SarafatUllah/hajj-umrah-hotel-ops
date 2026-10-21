import { describe, expect, it } from 'vitest'
import { normalizeRoomNumber } from '../../../shared/utils/roomNumber'

describe('normalizeRoomNumber', () => {
  it.each([
    [' 401 ', '401'],
    ['a-12', 'A-12'],
    ['٤٠١', '401'],
    ['401', '401'],
    ['4.01', '4.01'],
    ['4/01', '4/01'],
    ['b٢٥', 'B25'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeRoomNumber(input)).toBe(expected)
  })

  it.each([
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['A'.repeat(21), '21 characters (over the 20-character limit)'],
    ['4 01', 'inner whitespace'],
    ['🏨1', 'emoji'],
    ['-4', 'leading hyphen'],
  ])('rejects %j (%s) -> null', (input) => {
    expect(normalizeRoomNumber(input)).toBeNull()
  })

  it('accepts the 20-character boundary and rejects 21', () => {
    expect(normalizeRoomNumber('A'.repeat(20))).toBe('A'.repeat(20))
    expect(normalizeRoomNumber('A'.repeat(21))).toBeNull()
  })
})
