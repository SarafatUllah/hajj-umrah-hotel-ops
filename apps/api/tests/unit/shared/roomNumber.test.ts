import { describe, expect, it } from 'vitest'
import { normalizeRoomNumber, roomNumbersOfRange } from '@hajj/contracts/utils/roomNumber'

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

describe('roomNumbersOfRange (bulk create and its preview)', () => {
  it('numbers from the first to the last, after the prefix, padded when asked', () => {
    expect(roomNumbersOfRange({ prefix: '4', from: 1, to: 3, pad: 2 })).toEqual(['401', '402', '403'])
    expect(roomNumbersOfRange({ from: 9, to: 11 })).toEqual(['9', '10', '11'])
    expect(roomNumbersOfRange({ prefix: 'B', from: 5, to: 4 })).toEqual([])
  })
})
