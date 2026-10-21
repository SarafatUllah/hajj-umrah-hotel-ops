import type { Occupancy } from '@hajj/contracts/constants/booking'
import { mixCapFor, type PlannerInput, type SideNeed, stayNeeds, usesOwnRooms } from './planner'
import { isFreeForStay, isOwnRoomFor, type StayRoom } from './stayRooms'

/** A room of the option the booker chose (v7 §9.2 step 7), as sent back to be held. */
export interface ChosenRoom { roomId: string, occupancy: Occupancy, seats: number, extraBeds: number }

/**
 * Why a chosen option cannot be held. The room-level codes and OWN_ROOMS_FIRST depend on what other bookings and
 * inventory changes did since the search (search again); the rest mean the request itself breaks the rules.
 */
export type PlanProblemCode =
  | 'ROOM_UNKNOWN' | 'ROOM_REPEATED' | 'ROOM_NOT_SELLABLE' | 'ROOM_TAKEN' | 'WRONG_OCCUPANCY' | 'SEATS' | 'EXTRA_BEDS'
  | 'EXTRA_BEDS_UNUSED' | 'HEADCOUNT' | 'OWN_ROOMS_FIRST' | 'IDLE_ROOMS' | 'EXTRA_BEDS_UNNEEDED' | 'ROOM_MIX' | 'EXTRA_BED_LIMIT' | 'TOO_MANY_ROOMS'

export interface PlanProblem { code: PlanProblemCode, roomId?: string, occupancy?: Occupancy, roomTypeId?: string }

/** Rules for one chosen room against what the room offers now. */
function roomProblems(input: PlannerInput, chosen: ChosenRoom, room: StayRoom, occupancies: ReadonlySet<Occupancy>): PlanProblem[] {
  const at = (code: PlanProblemCode): PlanProblem => ({ code, roomId: chosen.roomId })
  if (!occupancies.has(chosen.occupancy)) return [at('WRONG_OCCUPANCY')]
  if (!room.sellable) return [at('ROOM_NOT_SELLABLE')]
  const existing = room.claims.length > 0
  if (existing && !(usesOwnRooms(input) && isOwnRoomFor(room, input.ownerKey!, chosen.occupancy, input.stay))) return [at('ROOM_TAKEN')]
  if (!existing && !isFreeForStay(room)) return [at('ROOM_NOT_SELLABLE')]

  const problems: PlanProblem[] = []
  // Extra beds only in this booking's new rooms, within the room's space, and only when they are slept in.
  if (chosen.extraBeds > 0 && (existing || chosen.extraBeds > room.extraBedSpace)) problems.push(at('EXTRA_BEDS'))
  else if (chosen.extraBeds > 0 && chosen.seats !== room.capacity + chosen.extraBeds) problems.push(at('EXTRA_BEDS_UNUSED'))
  const available = existing ? room.freeSeats : room.capacity + chosen.extraBeds
  if (chosen.seats < 1 || chosen.seats > available) problems.push(at('SEATS'))
  return problems
}

/**
 * The planner's economy rules for one side, so a hand-made option cannot claim more than it needs: with any new
 * room, every own room of the side is used and full ("own room first"); the new rooms leave fewer empty seats than
 * the smallest of them (no idle room); extra beds only when the new rooms are full.
 */
function sideProblems(input: PlannerInput, side: SideNeed, ofSide: readonly ChosenRoom[], rooms: ReadonlyMap<string, StayRoom>): PlanProblem[] {
  const newRooms = ofSide.filter(c => rooms.get(c.roomId)!.claims.length === 0)
  if (newRooms.length === 0) return []
  const problems: PlanProblem[] = []
  const at = (code: PlanProblemCode): PlanProblem => ({ code, occupancy: side.occupancy })
  if (usesOwnRooms(input)) {
    const chosenSeats = new Map(ofSide.map(c => [c.roomId, c.seats]))
    const own = input.rooms.filter(r => isOwnRoomFor(r, input.ownerKey!, side.occupancy, input.stay))
    if (own.some(r => chosenSeats.get(r.id) !== r.freeSeats)) problems.push(at('OWN_ROOMS_FIRST'))
  }
  const capacities = newRooms.map(c => rooms.get(c.roomId)!.capacity + c.extraBeds)
  const emptySeats = capacities.reduce((sum, n) => sum + n, 0) - newRooms.reduce((sum, c) => sum + c.seats, 0)
  if (emptySeats >= Math.min(...newRooms.map(c => rooms.get(c.roomId)!.capacity))) problems.push(at('IDLE_ROOMS'))
  if (emptySeats > 0 && newRooms.some(c => c.extraBeds > 0)) problems.push(at('EXTRA_BEDS_UNNEEDED'))
  return problems
}

/**
 * v7 §10 step 4 — the re-check inside the hold transaction, after the room locks: the chosen option must still
 * be one the planner could have offered. Every room sellable for the whole stay; a new room free of any claim, or
 * (agency GROUP) the agency's own room of the same gender and dates; seats within what the room has; extra beds
 * only in new rooms, slept in, within each type's per-booking limit; each side's head count exactly, its own rooms
 * first, no idle room, extra beds only when needed; the room-mix cap per side; an individual's room limit.
 * `input.rooms` must include the booker's own rooms for the stay (to check "own room first"). [] = it fits.
 */
export function checkStayPlan(input: PlannerInput, chosen: readonly ChosenRoom[]): PlanProblem[] {
  const rooms = new Map(input.rooms.map(r => [r.id, r]))
  const needs = stayNeeds(input.headcount)
  const occupancies = new Set(needs.map(n => n.occupancy))
  const problems: PlanProblem[] = []
  const seen = new Set<string>()
  for (const c of chosen) {
    const room = rooms.get(c.roomId)
    if (seen.has(c.roomId)) problems.push({ code: 'ROOM_REPEATED', roomId: c.roomId })
    else if (!room) problems.push({ code: 'ROOM_UNKNOWN', roomId: c.roomId })
    else problems.push(...roomProblems(input, c, room, occupancies))
    seen.add(c.roomId)
  }
  if (problems.length > 0) return problems

  for (const side of needs) {
    const ofSide = chosen.filter(c => c.occupancy === side.occupancy)
    if (ofSide.reduce((sum, c) => sum + c.seats, 0) !== side.need) problems.push({ code: 'HEADCOUNT', occupancy: side.occupancy })
    else problems.push(...sideProblems(input, side, ofSide, rooms))
    const cap = mixCapFor(input, side.need)
    const capped = ofSide.filter(c => rooms.get(c.roomId)!.claims.length === 0 && rooms.get(c.roomId)!.capacity >= (cap?.minSeats ?? Infinity))
    if (cap && capped.length > cap.maxRooms) problems.push({ code: 'ROOM_MIX', occupancy: side.occupancy })
  }
  const bedsByType = new Map<string, number>()
  for (const c of chosen) {
    const type = rooms.get(c.roomId)!.roomTypeId
    bedsByType.set(type, (bedsByType.get(type) ?? 0) + c.extraBeds)
  }
  for (const [roomTypeId, beds] of bedsByType) {
    if (beds > (input.extraBedLimits.get(roomTypeId) ?? 0)) problems.push({ code: 'EXTRA_BED_LIMIT', roomTypeId })
  }
  if (input.maxRooms !== null && chosen.length > input.maxRooms) problems.push({ code: 'TOO_MANY_ROOMS' })
  return problems
}
