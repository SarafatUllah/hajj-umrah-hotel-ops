import { describe, expect, it } from 'vitest'
import { guestSlots, reseatSlots, type SeatedSlot } from '../../../../server/domain/booking/guestSlots'
import { quoteFitsStay } from '../../../../server/domain/booking/quotes'
import { documentNo } from '../../../../server/domain/booking/references'

describe('guestSlots (v7 §7)', () => {
  it('GROUP: one slot per seated pilgrim in its room, children on the mother\'s side, the last of a room on its extra bed, infants last', () => {
    const slots = guestSlots(
      { bookingType: 'GROUP', maleCount: 3, femaleCount: 2, childCount: 1, totalCount: 6, childSide: 'MOTHER', infantCount: 1 },
      [{ roomId: 'm', occupancy: 'MALE', seats: 3, extraBeds: 1 }, { roomId: 'f', occupancy: 'FEMALE', seats: 3, extraBeds: 0 }],
    )
    expect(slots.map(s => [s.slotNo, s.roomId, s.gender, s.ageGroup, s.isExtraBed])).toEqual([
      [1, 'm', 'MALE', 'ADULT', false],
      [2, 'm', 'MALE', 'ADULT', false],
      [3, 'm', 'MALE', 'ADULT', true],
      [4, 'f', 'FEMALE', 'ADULT', false],
      [5, 'f', 'FEMALE', 'ADULT', false],
      [6, 'f', null, 'CHILD', false],
      [7, 'f', null, 'INFANT', false],
    ])
  })

  it('a side spread over rooms continues where the last room stopped; children with the father sleep on the men\'s side', () => {
    const slots = guestSlots(
      { bookingType: 'GROUP', maleCount: 2, femaleCount: 0, childCount: 2, totalCount: 4, childSide: 'FATHER', infantCount: 1 },
      [{ roomId: 'a', occupancy: 'MALE', seats: 2, extraBeds: 0 }, { roomId: 'b', occupancy: 'MALE', seats: 2, extraBeds: 0 }],
    )
    expect(slots.map(s => [s.roomId, s.ageGroup])).toEqual([['a', 'ADULT'], ['a', 'ADULT'], ['b', 'CHILD'], ['b', 'CHILD'], ['a', 'INFANT']])
  })

  it('FAMILY: slots without gender (read from the passport later), infants in the first room', () => {
    const slots = guestSlots({ bookingType: 'FAMILY', maleCount: 0, femaleCount: 0, childCount: 0, totalCount: 3, childSide: null, infantCount: 2 }, [{ roomId: 'r', occupancy: 'FAMILY', seats: 3, extraBeds: 0 }])
    expect(slots.map(s => [s.gender, s.ageGroup])).toEqual([[null, 'ADULT'], [null, 'ADULT'], [null, 'ADULT'], [null, 'INFANT'], [null, 'INFANT']])
  })
})

describe('reference numbers', () => {
  it('quotes Q-, bookings B-, year and at least four digits', () => {
    expect(documentNo('QUOTE', 2027, 7)).toBe('Q-2027-0007')
    expect(documentNo('BOOKING', 2028, 12345)).toBe('B-2028-12345')
  })
})

describe('quoteFitsStay (v7 §8)', () => {
  const quote = { hotelId: 'h', bookingType: 'GROUP' as const, checkIn: '2027-06-01', checkOut: '2027-06-05', maleCount: 10, femaleCount: 8, totalCount: 18 }
  const stay = { hotelId: 'h', bookingType: 'GROUP' as const, checkIn: '2027-06-01', checkOut: '2027-06-05', maleCount: 10, femaleCount: 6, childCount: 2, totalCount: 18, childSide: 'MOTHER' as const }

  it('the same hotel, dates, type and each side as quoted (children counted on the side they sleep on)', () => {
    expect(quoteFitsStay(quote, stay)).toBe(true)
    expect(quoteFitsStay(quote, { ...stay, childSide: 'FATHER' })).toBe(false)
    expect(quoteFitsStay(quote, { ...stay, checkOut: '2027-06-06' })).toBe(false)
    expect(quoteFitsStay(quote, { ...stay, hotelId: 'other' })).toBe(false)
  })

  it('a FAMILY quote needs only the same total', () => {
    const family = { ...quote, bookingType: 'FAMILY' as const, maleCount: 0, femaleCount: 0, totalCount: 4 }
    expect(quoteFitsStay(family, { ...stay, bookingType: 'FAMILY', maleCount: 0, femaleCount: 0, childCount: 0, totalCount: 4, childSide: null })).toBe(true)
    expect(quoteFitsStay(family, { ...stay, bookingType: 'FAMILY', maleCount: 0, femaleCount: 0, childCount: 0, totalCount: 5, childSide: null })).toBe(false)
  })
})

describe('reseatSlots (v7 §12 date change)', () => {
  const slot = (id: string, slotNo: number, side: SeatedSlot['side'], ageGroup: SeatedSlot['ageGroup'] = 'ADULT'): SeatedSlot => ({ id, slotNo, side, ageGroup })
  const group = { bookingType: 'GROUP' as const, childSide: 'MOTHER' as const }

  it('seats each side in the new rooms as a new booking would: adults first then by slot, the last of a room on its extra bed, infants with the children', () => {
    // Slot 2 is a child on the women's side, slot 6 a man added later; slot numbers need not follow the sides.
    const slots = [slot('w1', 1, 'FEMALE'), slot('c', 2, 'FEMALE', 'CHILD'), slot('m1', 3, 'MALE'), slot('m2', 4, 'MALE'), slot('i', 5, 'FEMALE', 'INFANT'), slot('m3', 6, 'MALE')]
    const seats = reseatSlots(slots, [{ roomId: 'f', occupancy: 'FEMALE', seats: 2, extraBeds: 0 }, { roomId: 'm', occupancy: 'MALE', seats: 3, extraBeds: 1 }], group)
    expect(seats).toEqual([
      { guestId: 'w1', roomId: 'f', isExtraBed: false },
      { guestId: 'c', roomId: 'f', isExtraBed: false },
      { guestId: 'm1', roomId: 'm', isExtraBed: false },
      { guestId: 'm2', roomId: 'm', isExtraBed: false },
      { guestId: 'm3', roomId: 'm', isExtraBed: true },
      { guestId: 'i', roomId: 'f', isExtraBed: false },
    ])
  })

  it('a FAMILY fills its rooms in order; infants join the first room', () => {
    const seats = reseatSlots([slot('a', 1, 'FAMILY'), slot('b', 2, 'FAMILY'), slot('c', 3, 'FAMILY', 'CHILD'), slot('i', 4, 'FAMILY', 'INFANT')], [{ roomId: 'x', occupancy: 'FAMILY', seats: 2, extraBeds: 0 }, { roomId: 'y', occupancy: 'FAMILY', seats: 1, extraBeds: 0 }], { bookingType: 'FAMILY', childSide: null })
    expect(seats?.map(s => [s.guestId, s.roomId])).toEqual([['a', 'x'], ['b', 'x'], ['c', 'y'], ['i', 'x']])
  })

  it('null when the rooms do not seat exactly the pilgrims each side has, or a seated slot sleeps nowhere', () => {
    const men = [slot('m1', 1, 'MALE'), slot('m2', 2, 'MALE')]
    expect(reseatSlots(men, [{ roomId: 'm', occupancy: 'MALE', seats: 3, extraBeds: 0 }], group)).toBeNull()
    expect(reseatSlots(men, [{ roomId: 'm', occupancy: 'MALE', seats: 2, extraBeds: 0 }, { roomId: 'f', occupancy: 'FEMALE', seats: 1, extraBeds: 0 }], group)).toBeNull()
    expect(reseatSlots([...men, slot('x', 3, null)], [{ roomId: 'm', occupancy: 'MALE', seats: 3, extraBeds: 0 }], group)).toBeNull()
  })
})
