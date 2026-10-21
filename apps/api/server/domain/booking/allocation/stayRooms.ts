import type { Occupancy } from '@hajj/contracts/constants/booking'
import { addDays, eachDate, type IsoDate, type NightRange } from '@hajj/contracts/utils/dates'
import { buildRoomSegments, type CalendarOptions, type RoomCalendarInput } from '../../inventory/calendar'
import type { NightSeats } from '../inventoryFit'

/** A stay `[checkIn, checkOut)`. */
export interface Stay { checkIn: IsoDate, checkOut: IsoDate }

/** A live claim (seat-holding, not an expired hold) overlapping the stay. `ownerKey` is `a:<agency>` or `b:<booking>`. */
export interface StayClaim {
  roomId: string
  bookingId: string
  ownerKey: string
  occupancy: Occupancy
  checkIn: IsoDate
  checkOut: IsoDate
  extraBeds: number
}

/** A room of the hotel with its inventory inputs (versions, overrides, blocks) for the stay. */
export interface HotelRoom {
  id: string
  roomNumber: string
  roomTypeId: string
  floorLevel: number
  calendar: RoomCalendarInput
}

/** An extra-bed policy (v7 §11, one per room type). */
export interface ExtraBedRule { roomTypeId: string, maxPerRoom: number, maxPerBooking: number, allowInOverrideSeason: boolean }

/** What one room offers for one stay (v7 §9.1). */
export interface StayRoom {
  id: string
  roomNumber: string
  roomTypeId: string
  floorLevel: number
  /** Sellable on every night (in inventory, no sale-blocking block). */
  sellable: boolean
  /** Usable seats: the smallest sellable capacity of any night (0 when not sellable). */
  capacity: number
  /** Free seats: the smallest (capacity + claimed extra beds − seated pilgrims) of any night (0 when not sellable). */
  freeSeats: number
  /** Live claims overlapping the stay. */
  claims: readonly StayClaim[]
  /** Extra beds a new claim may put here: the type's policy, none in a seasonal-override night unless allowed (§23 Q15). */
  extraBedSpace: number
}

export const stayNights = (stay: Stay): NightRange => ({ from: stay.checkIn, to: addDays(stay.checkOut, -1) })

const overlaps = (claim: StayClaim, night: IsoDate) => claim.checkIn <= night && night < claim.checkOut

function describeRoom(room: HotelRoom, stay: Stay, claims: readonly StayClaim[], seats: ReadonlyMap<string, number>, rule: ExtraBedRule | undefined, options: CalendarOptions): StayRoom {
  const segments = buildRoomSegments(room.calendar, stayNights(stay), options)
  const sellable = segments.length > 0 && segments.every(s => s.sellable && s.sellableCapacity !== null)
  const base = { id: room.id, roomNumber: room.roomNumber, roomTypeId: room.roomTypeId, floorLevel: room.floorLevel, claims }
  if (!sellable) return { ...base, sellable, capacity: 0, freeSeats: 0, extraBedSpace: 0 }

  let capacity = Infinity
  let freeSeats = Infinity
  for (const segment of segments) {
    for (const night of eachDate({ from: segment.from, to: segment.to })) {
      const extraBeds = claims.reduce((sum, c) => sum + (overlaps(c, night) ? c.extraBeds : 0), 0)
      capacity = Math.min(capacity, segment.sellableCapacity!)
      freeSeats = Math.min(freeSeats, segment.sellableCapacity! + extraBeds - (seats.get(`${room.id}|${night}`) ?? 0))
    }
  }
  const overrideSeason = segments.some(s => s.capacitySource === 'PERIOD_OVERRIDE')
  const extraBedSpace = rule && (rule.allowInOverrideSeason || !overrideSeason) ? Math.min(rule.maxPerRoom, rule.maxPerBooking) : 0
  return { ...base, sellable, capacity, freeSeats: Math.max(0, freeSeats), extraBedSpace }
}

/**
 * v7 §9.1 for every room: usable seats over the stay, free seats after live claims, and which claims are there.
 * Pure: the caller loads the rooms' inventory, the live claims and the seat counts over the stay's nights.
 */
export function describeStayRooms(args: {
  rooms: readonly HotelRoom[]
  stay: Stay
  claims: readonly StayClaim[]
  seats: readonly NightSeats[]
  extraBedRules: readonly ExtraBedRule[]
  options: CalendarOptions
}): StayRoom[] {
  const seats = new Map(args.seats.map(s => [`${s.roomId}|${s.night}`, s.seatsUsed]))
  const claimsByRoom = new Map<string, StayClaim[]>()
  for (const claim of args.claims) claimsByRoom.set(claim.roomId, [...(claimsByRoom.get(claim.roomId) ?? []), claim])
  const rules = new Map(args.extraBedRules.map(r => [r.roomTypeId, r]))
  return args.rooms.map(room => describeRoom(room, args.stay, claimsByRoom.get(room.id) ?? [], seats, rules.get(room.roomTypeId), args.options))
}

/** v7 §9.2 step 4, §9.3: free for the whole stay — sellable every night with seats, and no live claim at all. */
export const isFreeForStay = (room: StayRoom): boolean => room.sellable && room.capacity > 0 && room.claims.length === 0

/**
 * v7 §9.2 step 3, §23 Q10: the booker's own room for this stay — every live claim on it is this owner's, for
 * this occupancy, with exactly the stay's check-in and check-out — and it still has a free seat.
 */
export function isOwnRoomFor(room: StayRoom, ownerKey: string, occupancy: Occupancy, stay: Stay): boolean {
  return room.sellable && room.freeSeats > 0 && room.claims.length > 0
    && room.claims.every(c => c.ownerKey === ownerKey && c.occupancy === occupancy && c.checkIn === stay.checkIn && c.checkOut === stay.checkOut)
}
