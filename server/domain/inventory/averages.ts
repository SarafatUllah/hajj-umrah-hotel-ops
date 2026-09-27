import { type IsoDate, type NightRange, rangeLength } from '../../../shared/utils/dates'
import { type BaseVersion, type CapacityOverride, baseCapacityAt, capacitySegments, effectiveCapacityAt } from './capacity'

export interface RoomCapacityInput { roomId: string, versions: BaseVersion[], overrides: CapacityOverride[] }

export interface AverageResult {
  numerator: number
  denominator: number
  /** null when the denominator is 0 — never 0, NaN or Infinity. */
  value: number | null
  /** Half-up rounded to 2 decimals for display only; null when undefined. */
  display: string | null
  basis: 'ROOMS' | 'ROOM_NIGHTS'
}

/** Half-up decimal formatting of n/d with integer arithmetic only (no float rounding surprises). */
export function formatRatio(n: number, d: number, decimals = 2): string | null {
  if (d === 0) return null
  const scale = 10 ** decimals
  const a = n * scale * 2 + d
  const b = 2 * d
  const scaled = (a - (a % b)) / b
  const whole = Math.floor(scaled / scale)
  const frac = String(scaled % scale).padStart(decimals, '0')
  return `${whole}.${frac}`
}

export function makeAverage(numerator: number, denominator: number, basis: AverageResult['basis']): AverageResult {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator, display: formatRatio(numerator, denominator), basis }
}

/** Base Hotel Average on a date: sum of BASE sellable capacity / rooms in inventory (seasonal overrides ignored). */
export function baseHotelAverage(rooms: RoomCapacityInput[], date: IsoDate): AverageResult {
  let cap = 0
  let n = 0
  for (const r of rooms) {
    const b = baseCapacityAt(r.versions, date)
    if (b) { cap += b.sellableCapacity; n += 1 }
  }
  return makeAverage(cap, n, 'ROOMS')
}

/** Date-Effective Hotel Average: sum of EFFECTIVE sellable capacity / rooms in inventory on that date (operational blocks ignored). */
export function dateEffectiveHotelAverage(rooms: RoomCapacityInput[], date: IsoDate): AverageResult {
  let cap = 0
  let n = 0
  for (const r of rooms) {
    const e = effectiveCapacityAt(r.versions, r.overrides, date)
    if (e) { cap += e.sellableCapacity; n += 1 }
  }
  return makeAverage(cap, n, 'ROOMS')
}

/** Range average, weighted by room-nights: sum(capacity x nights) / sum(nights in inventory). */
export function rangeEffectiveAverage(rooms: RoomCapacityInput[], range: NightRange): AverageResult {
  let capNights = 0
  let roomNights = 0
  for (const r of rooms) {
    for (const s of capacitySegments(r.versions, r.overrides, range)) {
      const len = rangeLength(s)
      capNights += s.sellableCapacity * len
      roomNights += len
    }
  }
  return makeAverage(capNights, roomNights, 'ROOM_NIGHTS')
}

/** Weighted combination (e.g. all hotels): sums numerators and denominators; never averages averages. */
export function combineAverages(results: AverageResult[]): AverageResult {
  if (results.length === 0) return makeAverage(0, 0, 'ROOMS')
  const basis = results[0]!.basis
  if (results.some(r => r.basis !== basis)) throw new Error('Cannot combine averages with different bases')
  return makeAverage(results.reduce((s, r) => s + r.numerator, 0), results.reduce((s, r) => s + r.denominator, 0), basis)
}
