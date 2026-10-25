import type { AgeGroup, BookingType, ChildSide, Gender, Occupancy } from '@hajj/contracts/constants/booking'
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

/** Each side's people in the rooms, in the rooms' order: a room takes the next `seats` of its side, the last `extraBeds` of them on extra beds. */
function seatInRooms<T>(waiting: ReadonlyMap<Occupancy, readonly T[]>, rooms: readonly SlotRoom[]): Array<T & { isExtraBed: boolean, roomId: string }> {
  const seatedSoFar = new Map<Occupancy, number>()
  return rooms.flatMap((room) => {
    const from = seatedSoFar.get(room.occupancy) ?? 0
    seatedSoFar.set(room.occupancy, from + room.seats)
    return (waiting.get(room.occupancy) ?? []).slice(from, from + room.seats)
      .map((person, i) => ({ ...person, isExtraBed: i >= room.seats - room.extraBeds, roomId: room.roomId }))
  })
}

/** Where infants sleep (no seat): the first room of the side the children share (FAMILY: the first room). */
function infantRoomOf(booking: { bookingType: BookingType, childSide: ChildSide | null }, rooms: readonly SlotRoom[]): SlotRoom | undefined {
  const side: Occupancy = booking.bookingType === 'FAMILY' ? 'FAMILY' : booking.childSide === 'FATHER' ? 'MALE' : 'FEMALE'
  return rooms.find(r => r.occupancy === side) ?? rooms[0]
}

/**
 * The slots of a new booking (v7 §7): one per seated pilgrim in the room the option seats it in (GROUP slots
 * carry the side's gender; children and FAMILY slots get theirs from the passport later), the last pilgrims of a
 * room with extra beds on those beds, then one slot per infant (no seat) in the first room of the side the
 * children share (FAMILY: the first room). Assumes the rooms seat each side's head count exactly (the hold checks
 * that first).
 */
export function guestSlots(headcount: StayHeadcount & { infantCount: number }, rooms: readonly SlotRoom[]): GuestSlot[] {
  const seated = seatInRooms(sides(headcount), rooms)
  const infantRoom = infantRoomOf(headcount, rooms)
  const infants = infantRoom ? people(headcount.infantCount, { gender: null, ageGroup: 'INFANT' }).map(p => ({ ...p, isExtraBed: false, roomId: infantRoom.roomId })) : []
  return [...seated, ...infants].map((slot, i) => ({ ...slot, slotNo: i + 1 }))
}

/** A live slot of a booking moving to new dates: the side it sleeps on now (null: it sleeps nowhere). */
export interface SeatedSlot { id: string, slotNo: number, ageGroup: AgeGroup, side: Occupancy | null }

/** Where a slot sleeps after a date change. */
export interface Seat { guestId: string, roomId: string, isExtraBed: boolean }

const SEATING_ORDER: Readonly<Record<AgeGroup, number>> = { ADULT: 0, CHILD: 1, INFANT: 2 }

/**
 * v7 §12 date change: the booking's live slots (details kept) in the rooms of its new option, by the same rules as
 * a new booking's — each side's pilgrims in seating order (adults first, then by slot), the last of a room on its
 * extra beds, infants in the first room of the side the children share. null when the rooms do not seat exactly the
 * pilgrims each side has (the caller's plan check came first, so this means the slots and the booking's counts
 * disagree).
 */
export function reseatSlots(slots: readonly SeatedSlot[], rooms: readonly SlotRoom[], booking: { bookingType: BookingType, childSide: ChildSide | null }): Seat[] | null {
  const seated = slots.filter(s => s.ageGroup !== 'INFANT')
  const sideNames = new Set<Occupancy | null>([...seated.map(s => s.side), ...rooms.map(r => r.occupancy)])
  if (sideNames.has(null)) return null
  const waiting = new Map([...sideNames].map(side => [side!, seated.filter(s => s.side === side).sort((a, b) => SEATING_ORDER[a.ageGroup] - SEATING_ORDER[b.ageGroup] || a.slotNo - b.slotNo)]))
  const fits = [...waiting].every(([side, persons]) => rooms.filter(r => r.occupancy === side).reduce((sum, r) => sum + r.seats, 0) === persons.length)
  const infantRoom = infantRoomOf(booking, rooms)
  if (!fits || !infantRoom) return null
  const infants = slots.filter(s => s.ageGroup === 'INFANT').map(s => ({ guestId: s.id, roomId: infantRoom.roomId, isExtraBed: false }))
  return [...seatInRooms(waiting, rooms).map(s => ({ guestId: s.id, roomId: s.roomId, isExtraBed: s.isExtraBed })), ...infants]
}
