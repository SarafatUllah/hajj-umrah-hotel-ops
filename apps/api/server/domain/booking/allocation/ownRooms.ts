/** A room the booker already holds for these very dates (same agency and gender), with its free seats. */
export interface OwnRoom { roomId: string, freeSeats: number }

/** Pilgrims seated in an existing room. */
export interface SeatPlacement { roomId: string, seats: number }

/**
 * v7 §9.2 step 3 — "own room first": the booker's own rooms take the pilgrims before any new room, and rooms
 * that become completely full come first. When the own rooms cannot all be filled, the largest set of them
 * that fills exactly (subset sum over free seats) is filled and the rest go into one more own room — every
 * other own room has more free seats than are left (otherwise the set was not the largest). Deterministic:
 * rooms are considered by free seats (most first), then id.
 */
export function fillOwnRooms(need: number, ownRooms: readonly OwnRoom[]): { placements: SeatPlacement[], remaining: number } {
  const rooms = ownRooms.filter(r => r.freeSeats > 0).sort((a, b) => b.freeSeats - a.freeSeats || a.roomId.localeCompare(b.roomId))
  const total = rooms.reduce((sum, r) => sum + r.freeSeats, 0)
  if (need <= 0 || rooms.length === 0) return { placements: [], remaining: Math.max(0, need) }
  if (total <= need) return { placements: rooms.map(r => ({ roomId: r.roomId, seats: r.freeSeats })), remaining: need - total }

  // reachedBy[s] = index of the room that first reached the sum s (each room used once: classic 0/1 knapsack).
  const reachedBy = Array<number>(need + 1).fill(-1)
  const reachable = Array<boolean>(need + 1).fill(false)
  reachable[0] = true
  rooms.forEach((room, i) => {
    for (let s = need; s >= room.freeSeats; s--) {
      if (!reachable[s] && reachable[s - room.freeSeats]) {
        reachable[s] = true
        reachedBy[s] = i
      }
    }
  })
  let best = need
  while (!reachable[best]) best--
  const filled = new Set<number>()
  for (let s = best; s > 0; s -= rooms[reachedBy[s]!]!.freeSeats) filled.add(reachedBy[s]!)

  const placements = rooms.flatMap((r, i) => (filled.has(i) ? [{ roomId: r.roomId, seats: r.freeSeats }] : []))
  const left = need - best
  if (left > 0) {
    const partial = rooms.filter((_, i) => !filled.has(i)).sort((a, b) => a.freeSeats - b.freeSeats || a.roomId.localeCompare(b.roomId))[0]!
    placements.push({ roomId: partial.roomId, seats: left })
  }
  return { placements, remaining: 0 }
}
