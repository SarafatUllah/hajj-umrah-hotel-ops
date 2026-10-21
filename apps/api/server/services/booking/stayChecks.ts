import type { Occupancy } from '@hajj/contracts/constants/booking'
import type { PriceSource } from '@hajj/contracts/constants/pricing'
import type { StaySearchInput } from '@hajj/contracts/schemas/booking'
import { eachDate } from '@hajj/contracts/utils/dates'
import type { PlannerInput, StayPlan } from '../../domain/booking/allocation/planner'
import { quotaHeadroom } from '../../domain/booking/allocation/quota'
import type { ChosenRoom, PlanProblem, PlanProblemCode } from '../../domain/booking/allocation/stayPlanCheck'
import { stayNights } from '../../domain/booking/allocation/stayRooms'
import { isUnpriced, priceStay } from '../../domain/booking/pricing'
import { ConflictError, ValidationError } from '../../errors/domainError'
import { bookingRepos } from '../../repositories'
import type { HotelScope, OrganizationScope } from '../../security/scope'
import { findAgencyBrief } from '../accounts'
import type { Booker, StayFacts } from './stayFacts'

type Db = Parameters<typeof bookingRepos>[0]

export interface StayOptionRoom { roomId: string, roomNumber: string, floorLevel: number, roomTypeId: string, occupancy: Occupancy, seats: number, extraBeds: number, existing: boolean }

/** One complete option (v7 §9.2 step 7), priced on its actual rooms (empty seats never charged). */
export interface StayOption { rooms: StayOptionRoom[], newRooms: number, emptySeats: number, extraBeds: number, totalHalalas: number, priceSource: PriceSource }

export interface StaySearchResult {
  options: StayOption[]
  /** How many more persons the agency may still hold on every night of the stay (v7 §10); null = no quota. */
  quotaHeadroom: number | null
}

/** Problems that depend on what happened since the search ("someone was faster": search again). The rest mean the request itself is wrong. */
const UNAVAILABLE: ReadonlySet<PlanProblemCode> = new Set(['ROOM_NOT_SELLABLE', 'ROOM_TAKEN', 'SEATS', 'EXTRA_BEDS', 'OWN_ROOMS_FIRST'])

export function optionError(problems: readonly PlanProblem[]): Error {
  return problems.every(p => UNAVAILABLE.has(p.code))
    ? new ConflictError('OPTION_UNAVAILABLE', 'Some rooms of this option are no longer available; search again', { problems })
    : new ValidationError('INVALID_OPTION', 'This option does not fit the booking', { problems })
}

/** v7 §9.2 step 1: more persons than the quota leaves fails, saying how many are still possible. */
export function assertQuota(headroom: number | null, persons: number): void {
  if (headroom !== null && persons > headroom) throw new ValidationError('QUOTA_EXCEEDED', `The agency may hold at most ${headroom} more persons on these nights`, { maxPersons: headroom })
}

export async function quotaHeadroomFor(db: Db, hotelScope: HotelScope, agencyId: string, input: StaySearchInput, held: ReadonlyMap<string, number>): Promise<number | null> {
  const rows = await bookingRepos(db, hotelScope).agencyQuotas.list()
  return quotaHeadroom({ agencyId, nights: eachDate(stayNights(input)), rows, heldByNight: held })
}

/** Defence in depth: the agency routes already require an approved agency; staff act for approved agencies only. */
export async function assertApprovedAgency(db: Db, scope: OrganizationScope, booker: Booker): Promise<void> {
  if (booker.kind !== 'AGENCY') return
  const agency = await findAgencyBrief(db, scope, booker.agencyId)
  if (!agency || agency.status !== 'APPROVED') throw new ValidationError('AGENCY_NOT_APPROVED', 'Bookings are for approved agencies only')
}

/** The price of the rooms as chosen: pilgrims on regular beds by the seat price, extra beds at the policy price. */
export function priceRooms(facts: StayFacts, input: StaySearchInput, rooms: readonly ChosenRoom[], paidRoomIds: ReadonlySet<string> = new Set()) {
  return priceStay({
    ...facts.pricing,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    rooms: rooms.map(r => ({ roomTypeId: facts.rooms.get(r.roomId)!.roomTypeId, seats: r.seats - r.extraBeds, extraBeds: r.extraBeds, alreadyPaid: paidRoomIds.has(r.roomId) })),
  })
}

/**
 * The re-check's input: the planner's rooms (priced, the booker's own rooms included), plus any chosen room the
 * planner left out for want of a price — pricing refuses it then, with what is missing, rather than "unknown room".
 */
export function checkInput(facts: StayFacts, chosen: readonly ChosenRoom[]): PlannerInput {
  const planned = new Set(facts.planner.rooms.map(r => r.id))
  const unpriced = [...new Set(chosen.map(c => c.roomId))].filter(id => !planned.has(id) && facts.rooms.has(id)).map(id => ({ ...facts.rooms.get(id)!, price: 0 }))
  return { ...facts.planner, rooms: [...facts.planner.rooms, ...unpriced] }
}

export function toOption(plan: StayPlan, facts: StayFacts, input: StaySearchInput, paidRoomIds: ReadonlySet<string> = new Set()): StayOption[] {
  const priced = priceRooms(facts, input, plan.rooms, paidRoomIds)
  if (isUnpriced(priced)) return []
  const rooms = plan.rooms.map((r) => {
    const room = facts.rooms.get(r.roomId)!
    return { roomId: r.roomId, roomNumber: room.roomNumber, floorLevel: room.floorLevel, roomTypeId: r.roomTypeId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds, existing: r.existing }
  })
  return [{ rooms, newRooms: plan.newRooms, emptySeats: plan.emptySeats, extraBeds: plan.extraBeds, totalHalalas: priced.totalHalalas, priceSource: priced.source }]
}

