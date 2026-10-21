import type { AgeGroup, BookingType, ChildSide, Gender } from '@hajj/contracts/constants/booking'

/** A booking's head count as it is stored (v7 §7: GROUP men, women, children; FAMILY only the seated total; infants apart). */
export interface BookingCounts {
  maleCount: number
  femaleCount: number
  childCount: number
  infantCount: number
  /** Seated pilgrims (infants have no seat). */
  totalCount: number
}

/** A slot as it is now (its age group follows the passport's date of birth; REMOVED slots do not count). */
export interface CountedSlot { status: string, ageGroup: AgeGroup, gender: Gender | null }

export type RemovalRefusal = 'LAST_PILGRIM' | 'CHILDREN_NEED_AN_ADULT'

/**
 * The head count of the slots still on a booking, by what each slot is now — infants apart, a FAMILY only its seated
 * total. A removal recounts rather than decrements, so a slot whose passport moved it between adult and child never
 * leaves the counts negative or out of step.
 */
export function countsOfSlots(slots: readonly CountedSlot[], bookingType: BookingType): BookingCounts {
  const live = slots.filter(s => s.status !== 'REMOVED')
  const seated = live.filter(s => s.ageGroup !== 'INFANT')
  const infantCount = live.length - seated.length
  if (bookingType === 'FAMILY') return { maleCount: 0, femaleCount: 0, childCount: 0, infantCount, totalCount: seated.length }
  const adults = (gender: Gender) => seated.filter(s => s.ageGroup === 'ADULT' && s.gender === gender).length
  return { maleCount: adults('MALE'), femaleCount: adults('FEMALE'), childCount: seated.filter(s => s.ageGroup === 'CHILD').length, infantCount, totalCount: seated.length }
}

/** The head count with `added` pilgrims joining (v7 §12 "add a pilgrim"). */
export function countsWith(counts: BookingCounts, added: BookingCounts): BookingCounts {
  return {
    maleCount: counts.maleCount + added.maleCount,
    femaleCount: counts.femaleCount + added.femaleCount,
    childCount: counts.childCount + added.childCount,
    infantCount: counts.infantCount + added.infantCount,
    totalCount: counts.totalCount + added.totalCount,
  }
}

/**
 * Why a head count cannot stand, or null: a booking keeps at least one seated pilgrim (otherwise it is cancelled),
 * and children and infants keep an adult — in a GROUP, on the side the children sleep on.
 */
export function refuseHeadcount(counts: BookingCounts, bookingType: BookingType, childSide: ChildSide | null): RemovalRefusal | null {
  if (counts.totalCount === 0) return 'LAST_PILGRIM'
  if (bookingType === 'FAMILY') return null
  const adultsWithChildren = childSide === 'FATHER' ? counts.maleCount : counts.femaleCount
  return (counts.childCount > 0 || counts.infantCount > 0) && adultsWithChildren === 0 ? 'CHILDREN_NEED_AN_ADULT' : null
}
