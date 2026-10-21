/**
 * v7 §9.4: the best room combinations for `need` seated pilgrims of one side of a group (or a family) among
 * rooms that are free for the whole stay. Dynamic programming over room sizes instead of trying every subset
 * (a 300-pilgrim group has tens of millions of subsets). The state is (seats, extra-bed space, capped rooms):
 * extra-bed space is part of the state so a combination with room for an extra bed is never lost, and every
 * room with `cap.minSeats` or more usable seats counts against the room-mix cap (a Quad that holds 6 in Hajj
 * included). Inside one size a small knapsack finds the cheapest n rooms with a given extra-bed space.
 *
 * Deviations from the v7 listing (each checked against the brute force in the tests):
 * - options are distinct room mixes (the same mix at a higher price is not a second option);
 * - an option never contains a room nobody sleeps in (fewer than `need` seats would remain without it);
 * - equal options prefer bigger rooms (v7 §9.2 step 4e);
 * - each state keeps its best candidates in place (no list growth and sort per state: ticket 3).
 */

/** A room the allocator may add: free for the whole stay. */
export interface CandidateRoom {
  id: string
  /** Usable seats over the whole stay (the smallest capacity of any night, v7 §9.1). */
  seats: number
  /** Ranking measure only (v7 §9.4: the shown price is computed later from the chosen rooms). */
  price: number
  /** Extra beds this room can take (0 when its type has no policy or the season forbids them). */
  extraBeds: number
}

/** At most `maxRooms` rooms with `minSeats` or more usable seats (v7 §5 rule 10, §23 Q18). */
export interface MixCap { minSeats: number, maxRooms: number }

export interface OptionPolicy {
  cap: MixCap | null
  /** Most extra beds in the option (0 = none). */
  maxExtraBeds: number
  /** Most rooms in the option (an individual booker's limit, v7 §9.3), or null. */
  maxRooms: number | null
}

export interface RoomOption {
  /** Rooms per usable-seat size, largest size first: `[[6, 1], [4, 3]]`. */
  mix: ReadonlyArray<readonly [size: number, count: number]>
  rooms: number
  cost: number
  extraBeds: number
  emptySeats: number
}

/** Candidates kept per state; one more than the two options shown leaves room for the "no idle room" filter. */
const KEPT_PER_STATE = 3
/** Plain options shown (v7 §9.2 step 7: two or three options, the third being the extra-bed one). */
const PLAIN_OPTIONS = 2

interface Candidate { rooms: number, cost: number, counts: readonly number[] }
type Ranked = RoomOption & { counts: readonly number[] }

/** More rooms of the largest size first, then the next size (`counts` are indexed largest size first). */
function biggerRoomsFirst(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!
  return 0
}

const better = (a: Candidate, b: Candidate) => a.rooms - b.rooms || a.cost - b.cost || biggerRoomsFirst(a.counts, b.counts)
const sameMix = (a: readonly number[], b: readonly number[]) => a.every((n, i) => n === b[i])
/** Plain options all have 0 extra beds and extra-bed options 0 empty seats, so one order serves both lists. */
const optionOrder = (a: Ranked, b: Ranked) => a.extraBeds - b.extraBeds || a.emptySeats - b.emptySeats || better(a, b)

/** Keeps `cand` in `cell` if it is among the best distinct mixes (a cheaper copy of a kept mix replaces it). */
function keepBest(cell: Candidate[], cand: Candidate): void {
  const twin = cell.findIndex(kept => sameMix(kept.counts, cand.counts))
  if (twin >= 0) {
    if (cand.cost >= cell[twin]!.cost) return
    cell.splice(twin, 1)
  }
  else if (cell.length >= KEPT_PER_STATE && better(cand, cell[cell.length - 1]!) >= 0) return
  cell.push(cand)
  cell.sort(better)
  if (cell.length > KEPT_PER_STATE) cell.pop()
}

/** The (seats, extra-bed space, capped rooms) states, each with its best distinct mixes, in one flat array. */
class StateGrid {
  readonly cells: Candidate[][]

  constructor(readonly seats: number, readonly extra: number, readonly capped: number, cells?: Candidate[][]) {
    this.cells = cells ?? Array.from({ length: (seats + 1) * (extra + 1) * (capped + 1) }, () => [])
  }

  at(t: number, e: number, c: number): Candidate[] {
    return this.cells[(t * (this.extra + 1) + e) * (this.capped + 1) + c]!
  }

  copy(): StateGrid {
    return new StateGrid(this.seats, this.extra, this.capped, this.cells.map(cell => [...cell]))
  }

  forEach(visit: (t: number, e: number, c: number, cand: Candidate) => void): void {
    for (let t = 0; t <= this.seats; t++) {
      for (let e = 0; e <= this.extra; e++) {
        for (let c = 0; c <= this.capped; c++) for (const cand of this.at(t, e, c)) visit(t, e, c, cand)
      }
    }
  }

  /** The cap dimension is no longer needed once every capped size is placed: merge it away. */
  withoutCapDimension(): StateGrid {
    const merged = new StateGrid(this.seats, this.extra, 0)
    this.forEach((t, e, _c, cand) => keepBest(merged.at(t, e, 0), cand))
    return merged
  }
}

/** Within one size: the cheapest price of n rooms whose extra-bed space is e (capped at E). Infinity = impossible. */
function cheapestWithinSize(list: readonly CandidateRoom[], maxN: number, E: number): number[][] {
  const f = Array.from({ length: maxN + 1 }, () => Array<number>(E + 1).fill(Infinity))
  f[0]![0] = 0
  for (const room of list) {
    for (let n = maxN - 1; n >= 0; n--) {
      for (let e = 0; e <= E; e++) {
        if (f[n]![e] === Infinity) continue
        const e2 = Math.min(E, e + room.extraBeds)
        f[n + 1]![e2] = Math.min(f[n + 1]![e2]!, f[n]![e]! + room.price)
      }
    }
  }
  return f
}

function groupBySize(rooms: readonly CandidateRoom[]): Map<number, CandidateRoom[]> {
  const bySize = new Map<number, CandidateRoom[]>()
  for (const room of rooms) if (room.seats > 0) bySize.set(room.seats, [...(bySize.get(room.seats) ?? []), room])
  return bySize
}

/** One option per mix (the cheapest), best first. */
function distinctBest(list: readonly Ranked[]): Ranked[] {
  const best = new Map<string, Ranked>()
  for (const option of list) {
    const key = option.counts.join(',')
    const kept = best.get(key)
    if (!kept || option.cost < kept.cost) best.set(key, option)
  }
  return [...best.values()].sort(optionOrder)
}

/** Every reachable state after placing each size in turn (capped sizes first, so the cap dimension merges away early). */
function exploreStates(need: number, sizes: readonly number[], bySize: ReadonlyMap<number, readonly CandidateRoom[]>, policy: OptionPolicy): StateGrid {
  const E = Math.max(0, policy.maxExtraBeds)
  const maxRooms = policy.maxRooms ?? Infinity
  const isCapped = (size: number) => policy.cap !== null && size >= policy.cap.minSeats
  const order = [...sizes.filter(isCapped), ...sizes.filter(s => !isCapped(s))]
  const limit = need + sizes[0]!

  let grid = new StateGrid(limit, E, policy.cap?.maxRooms ?? 0)
  grid.at(0, 0, 0).push({ rooms: 0, cost: 0, counts: sizes.map(() => 0) })
  order.forEach((size, step) => {
    const capped = isCapped(size)
    const sizeIndex = sizes.indexOf(size)
    const list = bySize.get(size)!
    const maxN = Math.min(list.length, Math.floor(limit / size), capped ? grid.capped : Infinity, maxRooms)
    if (maxN > 0) {
      const f = cheapestWithinSize(list, maxN, E)
      const next = grid.copy()
      grid.forEach((t, e, c, cand) => {
        for (let n = 1; n <= maxN && t + n * size <= limit && cand.rooms + n <= maxRooms; n++) {
          const c2 = capped ? c + n : c
          if (c2 > grid.capped) break
          for (let es = 0; es <= E; es++) {
            const price = f[n]![es]!
            if (price === Infinity) continue
            const counts = cand.counts.map((k, i) => (i === sizeIndex ? k + n : k))
            keepBest(next.at(t + n * size, Math.min(E, e + es), c2), { rooms: cand.rooms + n, cost: cand.cost + price, counts })
          }
        }
      })
      grid = next
    }
    if (capped && !order.slice(step + 1).some(isCapped)) grid = grid.withoutCapDimension()
  })
  return grid
}

/**
 * Up to two plain options (fewest empty seats, then fewest rooms, then lowest cost, then bigger rooms), plus the
 * best extra-bed option (fewest extra beds first, v7 §9.4) when seats run short or it saves at least one room.
 */
export function suggestRoomOptions(need: number, rooms: readonly CandidateRoom[], policy: OptionPolicy): RoomOption[] {
  if (need <= 0) return []
  const bySize = groupBySize(rooms)
  const sizes = [...bySize.keys()].sort((a, b) => b - a)
  if (sizes.length === 0) return []

  const plain: Ranked[] = []
  const withExtra: Ranked[] = []
  const toOption = (cand: Candidate, extraBeds: number, emptySeats: number): Ranked => ({
    mix: sizes.flatMap((size, i) => (cand.counts[i]! > 0 ? [[size, cand.counts[i]!] as const] : [])),
    rooms: cand.rooms,
    cost: cand.cost,
    extraBeds,
    emptySeats,
    counts: cand.counts,
  })
  exploreStates(need, sizes, bySize, policy).forEach((t, e, _c, cand) => {
    if (cand.rooms === 0) return
    if (t >= need) {
      const smallest = sizes.findLast((_, i) => cand.counts[i]! > 0)!
      // A room nobody needs (removing it still seats everyone) makes no option.
      if (t - need < smallest) plain.push(toOption(cand, 0, t - need))
    }
    else if (need - t <= e) withExtra.push(toOption(cand, need - t, 0))
  })

  const options = distinctBest(plain).slice(0, PLAIN_OPTIONS)
  const bestExtra = distinctBest(withExtra)[0]
  if (bestExtra && (!options[0] || bestExtra.rooms < options[0].rooms)) options.push(bestExtra)
  return options.map(({ counts: _counts, ...option }) => option)
}
