import type { AgeGroup, Gender, Occupancy } from '@hajj/contracts/constants/booking'
import type { StayHeadcount } from './allocation/planner'

/** A room of the held option: who sleeps there and how many extra beds it got. */
export interface SlotRoom { roomId: string, occupancy: Occupancy, seats: number, extraBeds: number }

/** One pilgrim slot (v7 §7), filled with details later, and the room it sleeps in for the whole stay. */
export interface GuestSlot { slotNo: number, gender: Gender | null, ageGroup: AgeGroup, isExtraBed: boolean, roomId: string }

type Person = Pick<GuestSlot, 'gender' | 'ageGroup'>

const people = (count: number, person: Person): Person[] => Array.from({ length: count }, () => person)

/** Who sleeps on each side, in seating order: adults first, then the children sharing that side. */
function sides(headcount: StayHeadcount): Map<Occupancy, Person[]> {
  if (headcount.bookingType === 'FAMILY') return new Map([['FAMILY', people(headcount.totalCount, { gender: null, ageGroup: 'ADULT' })]])
  const child: Person = { gender: null, ageGroup: 'CHILD' }
  const withFather = headcount.childSide === 'FATHER'
  return new Map<Occupancy, Person[]>([
    ['MALE', [...people(headcount.maleCount, { gender: 'MALE', ageGroup: 'ADULT' }), ...people(withFather ? headcount.childCount : 0, child)]],
    ['FEMALE', [...people(headcount.femaleCount, { gender: 'FEMALE', ageGroup: 'ADULT' }), ...people(withFather ? 0 : headcount.childCount, child)]],
  ])
}

/**
 * The slots of a new booking (v7 §7): one per seated pilgrim in the room the option seats it in (GROUP slots
 * carry the side's gender; children and FAMILY slots get theirs from the passport later), the last pilgrims of a
 * room with extra beds on those beds, then one slot per infant (no seat) in the first room of the side the
 * children share (FAMILY: the first room). Assumes the rooms seat each side's head count exactly (the hold checks
 * that first).
 */
export function guestSlots(headcount: StayHeadcount & { infantCount: number }, rooms: readonly SlotRoom[]): GuestSlot[] {
  const waiting = sides(headcount)
  const seatedSoFar = new Map<Occupancy, number>()
  const seated = rooms.flatMap((room) => {
    const from = seatedSoFar.get(room.occupancy) ?? 0
    seatedSoFar.set(room.occupancy, from + room.seats)
    return (waiting.get(room.occupancy) ?? []).slice(from, from + room.seats)
      .map((person, i) => ({ ...person, isExtraBed: i >= room.seats - room.extraBeds, roomId: room.roomId }))
  })
  const infantSide: Occupancy = headcount.bookingType === 'FAMILY' ? 'FAMILY' : headcount.childSide === 'FATHER' ? 'MALE' : 'FEMALE'
  const infantRoom = rooms.find(r => r.occupancy === infantSide) ?? rooms[0]
  const infants = infantRoom ? people(headcount.infantCount, { gender: null, ageGroup: 'INFANT' }).map(p => ({ ...p, isExtraBed: false, roomId: infantRoom.roomId })) : []
  return [...seated, ...infants].map((slot, i) => ({ ...slot, slotNo: i + 1 }))
}
