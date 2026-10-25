import { describe, expect, it } from 'vitest'
import { floorLevels, levelName } from '../app/utils/floors'

const t = (key: string, named?: Record<string, unknown>) => (named ? `${key}:${Object.values(named).join(',')}` : key)

describe('floors (§25)', () => {
  it('a level reads "Ground" at 0, "B1" below it, its number above', () => {
    expect(levelName(0, t)).toBe('floors.ground')
    expect(levelName(-1, t)).toBe('floors.basement:1')
    expect(levelName(4, t)).toBe('4')
  })

  it('a bulk range lists every level from the first to the last, or nothing when reversed', () => {
    expect(floorLevels(2, 5)).toEqual([2, 3, 4, 5])
    expect(floorLevels(5, 2)).toEqual([])
  })
})
