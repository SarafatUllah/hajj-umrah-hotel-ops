import { describe, expect, it } from 'vitest'
import type { GuestSlotDto } from '@hajj/contracts/types/booking'
import { choiceItems } from '../app/utils/choices'
import { slotLabel } from '../app/utils/guest'

const t = (key: string, named?: Record<string, unknown>) => (named ? `${key}(${Object.values(named).join(',')})` : key)

describe('labels', () => {
  it('a fixed list of values becomes select items in its own order, each labelled', () => {
    expect(choiceItems(['FAMILY', 'GROUP'] as const, value => `type.${value}`)).toEqual([{ value: 'FAMILY', label: 'type.FAMILY' }, { value: 'GROUP', label: 'type.GROUP' }])
  })

  it('a place reads its number and age group, and in a group its side', () => {
    const slot = { slotNo: 3, ageGroup: 'ADULT', gender: 'FEMALE' } as GuestSlotDto
    expect(slotLabel(slot, t)).toBe('guest.place(3) · booking.ageGroup.ADULT · booking.gender.FEMALE')
    expect(slotLabel({ ...slot, gender: null }, t)).toBe('guest.place(3) · booking.ageGroup.ADULT')
  })
})
