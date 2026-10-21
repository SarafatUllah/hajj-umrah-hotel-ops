/** How a room looks on one night of the occupancy calendar (v7 §14 legend). */
export type RoomNightState = 'FULL' | 'PARTIAL' | 'HELD' | 'EMPTY' | 'BLOCKED'

/** One room on one night: whether it can be sold, its seats, and the seats taken. */
export interface RoomNight {
  /** In inventory and not covered by a sale-blocking block. */
  sellable: boolean
  capacity: number
  /** Seats of confirmed bookings (or in the house). */
  booked: number
  /** Seats of holds and requests not confirmed yet. */
  held: number
}

/**
 * The legend's state: a room nobody sits in is EMPTY (or BLOCKED when it cannot be sold); a room only holds sit in
 * is HELD (not confirmed); otherwise FULL once its seats are taken (extra beds may take it past them), else PARTIAL.
 */
export function roomNightState(night: RoomNight): RoomNightState {
  const used = night.booked + night.held
  if (used === 0) return night.sellable ? 'EMPTY' : 'BLOCKED'
  if (night.booked === 0) return 'HELD'
  return used >= night.capacity ? 'FULL' : 'PARTIAL'
}

export interface DayTotals {
  rooms: { total: number, full: number, partial: number, held: number, empty: number, blocked: number }
  /**
   * `total` = the sellable seats; `empty` = what is still free in sellable rooms. `pilgrims` and `held` count every
   * seated person, also in a room blocked after they were booked (so they may exceed `total - empty`).
   */
  seats: { total: number, pilgrims: number, held: number, empty: number }
  /** Seats taken (pilgrims and holds) of the sellable seats, whole percent, at most 100. */
  occupancyPercent: number
}

const STATE_KEY = { FULL: 'full', PARTIAL: 'partial', HELD: 'held', EMPTY: 'empty', BLOCKED: 'blocked' } as const

/** A day's summary over the rooms in inventory that night (v7 §14: rooms full/partial/HOLD/empty/blocked, seats). */
export function dayTotals(nights: readonly RoomNight[]): DayTotals {
  const rooms = { total: nights.length, full: 0, partial: 0, held: 0, empty: 0, blocked: 0 }
  const seats = { total: 0, pilgrims: 0, held: 0, empty: 0 }
  for (const night of nights) {
    rooms[STATE_KEY[roomNightState(night)]] += 1
    seats.pilgrims += night.booked
    seats.held += night.held
    if (night.sellable) {
      seats.total += night.capacity
      seats.empty += Math.max(0, night.capacity - night.booked - night.held)
    }
  }
  const taken = seats.total - seats.empty
  return { rooms, seats, occupancyPercent: seats.total === 0 ? 0 : Math.round((100 * taken) / seats.total) }
}
