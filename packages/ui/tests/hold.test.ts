import { describe, expect, it } from 'vitest'
import { holdLeft } from '../app/utils/hold'

const MINUTE = 60_000
const now = Date.parse('2027-06-01T10:00:00Z')
const until = (minutes: number) => new Date(now + minutes * MINUTE).toISOString()

describe('how long a hold still keeps its rooms (§36)', () => {
  it('counts minutes under an hour, hours under two days, then days', () => {
    expect(holdLeft(until(9.5), now)).toEqual({ unit: 'minute', count: 10, urgent: true })
    expect(holdLeft(until(150), now)).toEqual({ unit: 'hour', count: 2, urgent: true })
    expect(holdLeft(until(30 * 60), now)).toEqual({ unit: 'hour', count: 30, urgent: false })
    expect(holdLeft(until(3 * 24 * 60 + 5), now)).toEqual({ unit: 'day', count: 3, urgent: false })
  })

  it('is over at the expiry', () => {
    expect(holdLeft(until(0), now)).toEqual({ unit: 'minute', count: 0, urgent: true })
    expect(holdLeft(until(-5), now).count).toBe(0)
  })
})
