import { describe, expect, it } from 'vitest'
import { countsOfSlots, countsWith, refuseHeadcount } from '../../../../server/domain/booking/headcountChanges'

const group = { maleCount: 2, femaleCount: 1, childCount: 1, infantCount: 1, totalCount: 4 }

describe('head count changes (v7 §12)', () => {
  it('counts the slots still on the booking by what each is now (removed ones left out; a FAMILY only its total)', () => {
    const slots = [
      { status: 'READY', ageGroup: 'ADULT' as const, gender: 'MALE' as const },
      { status: 'REMOVED', ageGroup: 'ADULT' as const, gender: 'MALE' as const },
      { status: 'PENDING_DETAILS', ageGroup: 'ADULT' as const, gender: 'FEMALE' as const },
      { status: 'READY', ageGroup: 'CHILD' as const, gender: 'MALE' as const }, // a passport made this "man" a child
      { status: 'PENDING_DETAILS', ageGroup: 'INFANT' as const, gender: null },
    ]
    expect(countsOfSlots(slots, 'GROUP')).toEqual({ maleCount: 1, femaleCount: 1, childCount: 1, infantCount: 1, totalCount: 3 })
    expect(countsOfSlots(slots, 'FAMILY')).toEqual({ maleCount: 0, femaleCount: 0, childCount: 0, infantCount: 1, totalCount: 3 })
  })

  it('joining pilgrims add to every count', () => {
    expect(countsWith(group, { maleCount: 1, femaleCount: 0, childCount: 0, infantCount: 1, totalCount: 1 })).toEqual({ maleCount: 3, femaleCount: 1, childCount: 1, infantCount: 2, totalCount: 5 })
  })

  it('refuses a booking without a seated pilgrim, and children or infants without an adult on their side', () => {
    expect(refuseHeadcount({ ...group, totalCount: 0 }, 'GROUP', 'MOTHER')).toBe('LAST_PILGRIM')
    expect(refuseHeadcount({ ...group, femaleCount: 0, totalCount: 3 }, 'GROUP', 'MOTHER')).toBe('CHILDREN_NEED_AN_ADULT')
    expect(refuseHeadcount({ ...group, femaleCount: 0, totalCount: 3 }, 'GROUP', 'FATHER')).toBeNull()
    expect(refuseHeadcount({ maleCount: 1, femaleCount: 0, childCount: 0, infantCount: 1, totalCount: 1 }, 'GROUP', 'MOTHER')).toBe('CHILDREN_NEED_AN_ADULT')
    expect(refuseHeadcount({ maleCount: 0, femaleCount: 0, childCount: 0, infantCount: 1, totalCount: 1 }, 'FAMILY', null)).toBeNull()
  })
})
