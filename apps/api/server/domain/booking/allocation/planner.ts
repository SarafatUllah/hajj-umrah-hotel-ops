import type { BookingType, ChildSide, Occupancy } from '@hajj/contracts/constants/booking'
import { fillOwnRooms } from './ownRooms'
import { type CandidateRoom, type MixCap, type RoomOption, suggestRoomOptions } from './roomOptions'
import { type PickableRoom, type PickedRoom, pickRooms } from './roomPicking'
import { isFreeForStay, isOwnRoomFor, type Stay, type StayRoom } from './stayRooms'

/** Who and how many (v7 §5–6): GROUP counts by side, FAMILY only the total; infants never take a seat. */
export interface StayHeadcount {
  bookingType: BookingType
  maleCount: number
  femaleCount: number
  childCount: number
  totalCount: number
  /** Whose rooms a GROUP's children share (§23 Q16; null = the mother's). */
  childSide: ChildSide | null
}

/** A room-mix rule (v7 §5 rule 10): for a side of `groupMin`..`groupMax` pilgrims (§23 Q11), at most `maxRooms` rooms of `minSeats`+. */
export interface MixRule { groupMin: number, groupMax: number | null, minSeats: number, maxRooms: number }

/** A room of the stay with its ranking price (the caller leaves out rooms it cannot price). */
export interface PlannerRoom extends StayRoom { price: number }

export interface PlannerInput {
  stay: Stay
  headcount: StayHeadcount
  rooms: readonly PlannerRoom[]
  /** The agency's owner key (`a:<agencyId>`): its GROUP bookings fill its own rooms first. null for anyone else. */
  ownerKey: string | null
  /** Pilgrims added to a booking (v7 §12): its own rooms come first whatever its type (`ownerKey` = the booking's own). */
  ownRoomsAnyType?: boolean
  mixRules: readonly MixRule[]
  /** Per room type: the most extra beds one booking may take there (v7 §11; absent = none). */
  extraBedLimits: ReadonlyMap<string, number>
  /** An individual booker's most rooms per booking (v7 §9.3), or null. */
  maxRooms: number | null
  /** Floors of the booker's other rooms in the hotel during the stay (v7 §9.2 step 6). */
  anchorLevels: readonly number[]
}

export interface PlannedRoom {
  roomId: string
  roomTypeId: string
  occupancy: Occupancy
  /** Pilgrims this booking seats here, extra-bed pilgrims included. */
  seats: number
  extraBeds: number
  /** A room the booker already holds for these dates ("own room first"). */
  existing: boolean
}

/** One complete option (v7 §9.2 step 7). Empty seats and room counts are of the new rooms. */
export interface StayPlan { rooms: PlannedRoom[], newRooms: number, emptySeats: number, extraBeds: number, cost: number }

export interface SideNeed { occupancy: Occupancy, need: number }

/** The seats each side needs: FAMILY one side; GROUP men and women apart, children on their parent's side. */
export function stayNeeds(headcount: StayHeadcount): SideNeed[] {
  if (headcount.bookingType === 'FAMILY') return [{ occupancy: 'FAMILY', need: headcount.totalCount }]
  const childrenWithMen = headcount.childSide === 'FATHER' ? headcount.childCount : 0
  return [
    { occupancy: 'MALE' as const, need: headcount.maleCount + childrenWithMen },
    { occupancy: 'FEMALE' as const, need: headcount.femaleCount + headcount.childCount - childrenWithMen },
  ].filter(side => side.need > 0)
}

/** Whether the booker's own rooms take its pilgrims first: an agency's GROUP, or pilgrims added to any booking. */
export function usesOwnRooms(input: Pick<PlannerInput, 'ownerKey' | 'headcount' | 'ownRoomsAnyType'>): boolean {
  return input.ownerKey !== null && (input.headcount.bookingType === 'GROUP' || input.ownRoomsAnyType === true)
}

/** The room-mix cap for a GROUP side of `need` pilgrims (§23 Q11: per side); FAMILY has none (v7 §9.3). */
export function mixCapFor(input: Pick<PlannerInput, 'headcount' | 'mixRules'>, need: number): MixCap | null {
  if (input.headcount.bookingType !== 'GROUP') return null
  const rule = input.mixRules.find(r => r.groupMin <= need && (r.groupMax === null || need <= r.groupMax))
  return rule ? { minSeats: rule.minSeats, maxRooms: rule.maxRooms } : null
}

interface Side extends SideNeed { ownRooms: PlannedRoom[], remaining: number, cap: MixCap | null, anchors: readonly number[] }
interface Budget { extraBeds: number, rooms: number, typeLimits: ReadonlyMap<string, number> }

const toPickable = (r: PlannerRoom): PickableRoom => ({ id: r.id, roomNumber: r.roomNumber, roomTypeId: r.roomTypeId, floorLevel: r.floorLevel, seats: r.capacity, price: r.price, extraBedSpace: r.extraBedSpace })

/** Step 3 for one side: the booker's own rooms (same owner, gender and dates) take its pilgrims first. */
function ownRoomsFirst(input: PlannerInput, side: SideNeed): Side {
  const own = usesOwnRooms(input)
    ? input.rooms.filter(r => isOwnRoomFor(r, input.ownerKey!, side.occupancy, input.stay))
    : []
  const filled = fillOwnRooms(side.need, own.map(r => ({ roomId: r.id, freeSeats: r.freeSeats })))
  const used = filled.placements.map(p => ({ room: own.find(r => r.id === p.roomId)!, seats: p.seats }))
  return {
    ...side,
    ownRooms: used.map(({ room, seats }) => ({ roomId: room.id, roomTypeId: room.roomTypeId, occupancy: side.occupancy, seats, extraBeds: 0, existing: true })),
    remaining: filled.remaining,
    cap: mixCapFor(input, side.need),
    anchors: used.length > 0 ? used.map(u => u.room.floorLevel) : input.anchorLevels,
  }
}

/** Seats a side's remaining pilgrims in its new rooms: biggest rooms first, each full (extra beds included) until none are left. */
function seatPilgrims(side: Side, picked: readonly PickedRoom[]): PlannedRoom[] {
  let left = side.remaining
  return picked.map(({ room, extraBeds }) => {
    const seats = Math.min(room.seats + extraBeds, left)
    left -= seats
    return { roomId: room.id, roomTypeId: room.roomTypeId, occupancy: side.occupancy, seats, extraBeds, existing: false }
  })
}

function spend(budget: Budget, option: RoomOption, picked: readonly PickedRoom[]): Budget {
  const typeLimits = new Map(budget.typeLimits)
  for (const p of picked) if (p.extraBeds > 0) typeLimits.set(p.room.roomTypeId, (typeLimits.get(p.room.roomTypeId) ?? 0) - p.extraBeds)
  return { extraBeds: budget.extraBeds - option.extraBeds, rooms: budget.rooms - picked.length, typeLimits }
}

const asCandidate = (budget: Budget) => (r: PickableRoom): CandidateRoom =>
  ({ id: r.id, seats: r.seats, price: r.price, extraBeds: Math.min(r.extraBedSpace, budget.typeLimits.get(r.roomTypeId) ?? 0) })

/** Steps 4–6 for the sides from `index` on: each option of this side, its concrete rooms, then the next side on what is left. */
function allocateFrom(sides: readonly Side[], index: number, pool: readonly PickableRoom[], budget: Budget): StayPlan[] {
  if (index === sides.length) return [{ rooms: [], newRooms: 0, emptySeats: 0, extraBeds: 0, cost: 0 }]
  const side = sides[index]!
  const withOwnRooms = (plan: StayPlan): StayPlan => ({ ...plan, rooms: [...side.ownRooms, ...plan.rooms] })
  if (side.remaining === 0) return allocateFrom(sides, index + 1, pool, budget).map(withOwnRooms)

  const policy = { cap: side.cap, maxExtraBeds: budget.extraBeds, maxRooms: Number.isFinite(budget.rooms) ? budget.rooms : null }
  return suggestRoomOptions(side.remaining, pool.map(asCandidate(budget)), policy).flatMap((option) => {
    const picked = pickRooms({ mix: option.mix, extraBeds: option.extraBeds, pool, anchorLevels: side.anchors, typeLimits: budget.typeLimits })
    if (!picked) return []
    const taken = new Set(picked.map(p => p.room.id))
    const rooms = seatPilgrims(side, picked)
    const cost = picked.reduce((sum, p) => sum + p.room.price, 0)
    return allocateFrom(sides, index + 1, pool.filter(r => !taken.has(r.id)), spend(budget, option, picked)).map(rest => withOwnRooms({
      rooms: [...rooms, ...rest.rooms],
      newRooms: picked.length + rest.newRooms,
      emptySeats: option.emptySeats + rest.emptySeats,
      extraBeds: option.extraBeds + rest.extraBeds,
      cost: cost + rest.cost,
    }))
  })
}

const planOrder = (a: StayPlan, b: StayPlan) => a.extraBeds - b.extraBeds || a.emptySeats - b.emptySeats || a.newRooms - b.newRooms || a.cost - b.cost

/** Distinct room sets, best first. */
function distinctPlans(plans: readonly StayPlan[]): StayPlan[] {
  const seen = new Set<string>()
  return [...plans].sort(planOrder).filter((plan) => {
    const key = plan.rooms.map(r => `${r.roomId}:${r.occupancy}`).sort().join(',')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * v7 §9.2 (GROUP) and §9.3 (FAMILY): the two best complete options, plus the best extra-bed option when seats
 * run short or it needs fewer new rooms. GROUP sides are placed one after the other (the side with more pilgrims
 * left first), each on the rooms the other has not taken, so the options never share a room. [] = no option
 * (not enough sellable seats for these dates).
 */
export function planStay(input: PlannerInput): StayPlan[] {
  const sides = stayNeeds(input.headcount).map(side => ownRoomsFirst(input, side)).sort((a, b) => b.remaining - a.remaining)
  const pool = input.rooms.filter(isFreeForStay).map(toPickable)
  const budget: Budget = {
    extraBeds: Math.max(0, ...input.extraBedLimits.values()),
    rooms: input.maxRooms ?? Infinity,
    typeLimits: input.extraBedLimits,
  }
  const plans = allocateFrom(sides, 0, pool, budget)
  const plain = distinctPlans(plans.filter(p => p.extraBeds === 0)).slice(0, 2)
  const bestExtra = distinctPlans(plans.filter(p => p.extraBeds > 0))[0]
  return bestExtra && (!plain[0] || bestExtra.newRooms < plain[0].newRooms) ? [...plain, bestExtra] : plain
}
