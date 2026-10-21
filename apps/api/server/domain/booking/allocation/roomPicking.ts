/** A free room the picker may choose, with its usable seats, ranking price and extra-bed space. */
export interface PickableRoom {
  id: string
  roomNumber: string
  roomTypeId: string
  floorLevel: number
  seats: number
  price: number
  extraBedSpace: number
}

export interface PickedRoom { room: PickableRoom, extraBeds: number }

const byRoomNumber = (a: PickableRoom, b: PickableRoom) =>
  a.roomNumber.length - b.roomNumber.length || a.roomNumber.localeCompare(b.roomNumber) || a.id.localeCompare(b.id)

/** The lower median: the anchor floor of the booker's other rooms. */
function median(levels: readonly number[]): number {
  const sorted = [...levels].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]!
}

/**
 * Puts `extraBeds` into the chosen rooms (most space first), within each room's space and each room type's
 * per-booking limit (`typeLimits`: what is left of it). null = they do not fit.
 */
function placeExtraBeds(rooms: readonly PickableRoom[], extraBeds: number, typeLimits: ReadonlyMap<string, number>): number[] | null {
  const assigned = rooms.map(() => 0)
  const usedByType = new Map<string, number>()
  let left = extraBeds
  const order = rooms.map((_, i) => i).sort((a, b) => rooms[b]!.extraBedSpace - rooms[a]!.extraBedSpace || a - b)
  for (const i of order) {
    if (left === 0) break
    const room = rooms[i]!
    const take = Math.min(left, room.extraBedSpace, (typeLimits.get(room.roomTypeId) ?? 0) - (usedByType.get(room.roomTypeId) ?? 0))
    if (take <= 0) continue
    assigned[i] = take
    usedByType.set(room.roomTypeId, (usedByType.get(room.roomTypeId) ?? 0) + take)
    left -= take
  }
  return left === 0 ? assigned : null
}

export interface PickArgs {
  /** Rooms per usable-seat size (an option's mix). */
  mix: ReadonlyArray<readonly [size: number, count: number]>
  extraBeds: number
  pool: readonly PickableRoom[]
  /** Floors of the booker's other rooms for this stay (v7 §9.2 step 6: near them); empty = any floor. */
  anchorLevels: readonly number[]
  /** What is left of each room type's per-booking extra-bed limit. */
  typeLimits: ReadonlyMap<string, number>
}

interface Pick { rooms: PickableRoom[], extraBeds: number[], distance: number, price: number }

function pickAround(anchor: number, args: PickArgs): Pick | null {
  const distance = (r: PickableRoom) => Math.abs(r.floorLevel - anchor)
  const nearest = (a: PickableRoom, b: PickableRoom) => distance(a) - distance(b) || a.price - b.price || byRoomNumber(a, b)
  const chosen: PickableRoom[] = []
  for (const [size, count] of args.mix) {
    const candidates = args.pool.filter(r => r.seats === size).sort(nearest)
    if (candidates.length < count) return null
    chosen.push(...candidates.slice(0, count))
  }

  let beds = placeExtraBeds(chosen, args.extraBeds, args.typeLimits)
  // Not enough extra-bed space near the anchor: swap the farthest chosen room for the nearest same-size room with
  // more space, one at a time (each swap adds space, so this ends).
  while (!beds) {
    const taken = new Set(chosen.map(r => r.id))
    const swap = args.pool.filter(r => !taken.has(r.id) && r.extraBedSpace > 0).sort(nearest)
      .map(incoming => ({ incoming, outgoing: chosen.filter(c => c.seats === incoming.seats && c.extraBedSpace < incoming.extraBedSpace).sort(nearest).at(-1) }))
      .find(s => s.outgoing)
    if (!swap) return null
    chosen[chosen.indexOf(swap.outgoing!)] = swap.incoming
    beds = placeExtraBeds(chosen, args.extraBeds, args.typeLimits)
  }
  return { rooms: chosen, extraBeds: beds, distance: chosen.reduce((sum, r) => sum + distance(r), 0), price: chosen.reduce((sum, r) => sum + r.price, 0) }
}

/**
 * v7 §9.2 step 6: the concrete rooms for an option — the same or nearby floors (around the booker's other rooms
 * when it has some, otherwise around whichever floor keeps the rooms closest together), then the cheaper room,
 * then the room number; the extra beds go where there is space. null = the pool cannot supply the mix.
 */
export function pickRooms(args: PickArgs): PickedRoom[] | null {
  const anchors = args.anchorLevels.length > 0 ? [median(args.anchorLevels)] : [...new Set(args.pool.map(r => r.floorLevel))].sort((a, b) => a - b)
  let best: Pick | null = null
  for (const anchor of anchors) {
    const pick = pickAround(anchor, args)
    if (pick && (!best || (pick.distance - best.distance || pick.price - best.price) < 0)) best = pick
  }
  return best ? best.rooms.map((room, i) => ({ room, extraBeds: best.extraBeds[i]! })) : null
}
