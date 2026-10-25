import { describe, expect, it } from 'vitest'
import { type CandidateRoom, type OptionPolicy, type RoomOption, suggestRoomOptions } from '../../../../../server/domain/booking/allocation/roomOptions'

const room = (id: string, seats: number, price = seats * 100, extraBeds = 0): CandidateRoom => ({ id, seats, price, extraBeds })
const rooms = (spec: Array<[count: number, seats: number, extraBeds?: number]>): CandidateRoom[] =>
  spec.flatMap(([count, seats, extraBeds = 0], g) => Array.from({ length: count }, (_, i) => room(`r${g}-${i}`, seats, seats * 100, extraBeds)))
const open: OptionPolicy = { cap: null, maxExtraBeds: 0, maxRooms: null }

/** Seeded PRNG (mulberry32): the property test is the same on every run. */
function prng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The "right answer" from every subset of the actual rooms (v7 §9.4: each room's own price and extra-bed space,
 * 6-seat rooms, the "5 or more seats" cap): the same selection rules, no dynamic programming.
 */
function bruteForce(need: number, list: readonly CandidateRoom[], policy: OptionPolicy): RoomOption[] {
  const sizes = [...new Set(list.map(r => r.seats))].sort((a, b) => b - a)
  const limit = need + (sizes[0] ?? 0)
  const E = policy.maxExtraBeds
  type Found = RoomOption & { counts: number[] }
  const plain = new Map<string, Found>()
  const extra = new Map<string, Found>()
  for (let mask = 1; mask < 1 << list.length; mask++) {
    const chosen = list.filter((_, i) => mask & (1 << i))
    if (policy.maxRooms !== null && chosen.length > policy.maxRooms) continue
    if (policy.cap && chosen.filter(r => r.seats >= policy.cap!.minSeats).length > policy.cap.maxRooms) continue
    const t = chosen.reduce((sum, r) => sum + r.seats, 0)
    if (t > limit) continue
    const space = Math.min(E, chosen.reduce((sum, r) => sum + r.extraBeds, 0))
    const cost = chosen.reduce((sum, r) => sum + r.price, 0)
    const counts = sizes.map(size => chosen.filter(r => r.seats === size).length)
    const option: Found = { mix: sizes.flatMap((size, i) => (counts[i]! > 0 ? [[size, counts[i]!] as const] : [])), rooms: chosen.length, cost, extraBeds: 0, emptySeats: 0, counts }
    const key = counts.join(',')
    const smallest = Math.min(...chosen.map(r => r.seats))
    if (t >= need && t - need < smallest) {
      if (!plain.has(key) || cost < plain.get(key)!.cost) plain.set(key, { ...option, emptySeats: t - need })
    }
    else if (t < need && need - t <= space) {
      if (!extra.has(key) || cost < extra.get(key)!.cost) extra.set(key, { ...option, extraBeds: need - t })
    }
  }
  const bigger = (a: Found, b: Found) => {
    for (let i = 0; i < a.counts.length; i++) if (a.counts[i] !== b.counts[i]) return b.counts[i]! - a.counts[i]!
    return 0
  }
  const order = (a: Found, b: Found) => a.extraBeds - b.extraBeds || a.emptySeats - b.emptySeats || a.rooms - b.rooms || a.cost - b.cost || bigger(a, b)
  const options = [...plain.values()].sort(order).slice(0, 2)
  const bestExtra = [...extra.values()].sort(order)[0]
  if (bestExtra && (!options[0] || bestExtra.rooms < options[0].rooms)) options.push(bestExtra)
  return options.map(({ counts: _counts, ...option }) => option)
}

describe('suggestRoomOptions (v7 §9.4)', () => {
  it('fewest empty seats first, then fewest rooms, then bigger rooms; a second option is a different mix', () => {
    const options = suggestRoomOptions(10, rooms([[3, 4], [2, 3], [2, 2]]), open)
    expect(options.map(o => [o.mix, o.emptySeats, o.rooms])).toEqual([
      [[[4, 2], [2, 1]], 0, 3],
      [[[4, 1], [3, 2]], 0, 3],
    ])
  })

  it('20 pilgrims, 19 seats: no plain option, one extra bed instead of refusing (v7 §11 case 1)', () => {
    const options = suggestRoomOptions(20, rooms([[4, 4, 1], [1, 3]]), { ...open, maxExtraBeds: 2 })
    expect(options).toEqual([{ mix: [[4, 4], [3, 1]], rooms: 5, cost: 1900, extraBeds: 1, emptySeats: 0 }])
  })

  it('the last pilgrim needs a whole room: the extra-bed option appears beside it (v7 §11 case 2)', () => {
    const options = suggestRoomOptions(9, rooms([[2, 4, 1], [2, 5]]), { ...open, maxExtraBeds: 1 })
    expect(options.map(o => [o.mix, o.rooms, o.extraBeds])).toEqual([
      [[[5, 1], [4, 1]], 2, 0],
      [[[5, 2]], 2, 0],
    ])
    const tight = suggestRoomOptions(9, rooms([[3, 4, 1]]), { ...open, maxExtraBeds: 1 })
    expect(tight.map(o => [o.mix, o.rooms, o.extraBeds, o.emptySeats])).toEqual([
      [[[4, 3]], 3, 0, 3],
      [[[4, 2]], 2, 1, 0],
    ])
  })

  it('an extra-bed combination is not lost to a cheaper one without extra-bed space (the v6 bug)', () => {
    const list = [room('cheap-a', 4, 100), room('cheap-b', 4, 100), room('roomy', 4, 900, 1)]
    expect(suggestRoomOptions(9, list, { ...open, maxExtraBeds: 1 })).toContainEqual({ mix: [[4, 2]], rooms: 2, cost: 1000, extraBeds: 1, emptySeats: 0 })
  })

  it('the cap counts rooms of 5 or more usable seats, a Hajj 6-seat Quad included (the other v6 bug)', () => {
    const list = rooms([[3, 6], [3, 4]])
    expect(suggestRoomOptions(12, list, open)[0]!.mix).toEqual([[6, 2]])
    const options = suggestRoomOptions(12, list, { ...open, cap: { minSeats: 5, maxRooms: 1 } })
    expect(options.map(o => o.mix)).toEqual([[[4, 3]], [[6, 1], [4, 2]]])
  })

  it('a lone pilgrim gets the smallest room (§23 Q12); nothing fits: no option', () => {
    expect(suggestRoomOptions(1, rooms([[1, 4], [1, 2]]), open)[0]!.mix).toEqual([[2, 1]])
    expect(suggestRoomOptions(9, rooms([[2, 4]]), open)).toEqual([])
    expect(suggestRoomOptions(3, [], open)).toEqual([])
  })

  it('never more rooms than an individual booker may take', () => {
    expect(suggestRoomOptions(8, rooms([[4, 2], [1, 8]]), { ...open, maxRooms: 1 }).map(o => o.mix)).toEqual([[[8, 1]]])
  })

  it('equal on seats, rooms and cost: bigger rooms first (v7 §9.2 step 4e)', () => {
    const list = [room('a', 4, 300), room('b', 2, 150), room('c', 3, 225), room('d', 3, 225)]
    expect(suggestRoomOptions(6, list, open)[0]!.mix).toEqual([[4, 1], [2, 1]])
  })

  it('matches the brute force over every subset of the real rooms in 10,000 random cases', () => {
    const random = prng(20271021)
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
    let withExtra = 0
    let cappedSix = 0
    for (let i = 0; i < 10_000; i++) {
      const list = Array.from({ length: int(3, 12) }, (_, k) => room(`r${k}`, int(1, 6), int(1, 40) * 25, int(0, 2) === 2 ? int(1, 2) : 0))
      const policy: OptionPolicy = {
        cap: random() < 0.5 ? { minSeats: 5, maxRooms: int(0, 3) } : null,
        maxExtraBeds: int(0, 2),
        maxRooms: random() < 0.2 ? int(1, 5) : null,
      }
      const need = int(1, list.reduce((sum, r) => sum + r.seats, 0) + 2)
      const expected = bruteForce(need, list, policy)
      expect(suggestRoomOptions(need, list, policy), `case ${i}: need ${need}, ${JSON.stringify({ list, policy })}`).toEqual(expected)
      if (expected.some(o => o.extraBeds > 0)) withExtra++
      if (policy.cap && list.some(r => r.seats === 6)) cappedSix++
    }
    // The cases exercise both v6 bugs.
    expect(withExtra).toBeGreaterThan(500)
    expect(cappedSix).toBeGreaterThan(2_000)
  }, 60_000) // ~2 s locally, 8 s on a CI runner: past Vitest's 5 s default
})
