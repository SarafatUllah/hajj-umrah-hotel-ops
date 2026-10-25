import { describe, expect, it } from 'vitest'
import { safeRedirect } from '../app/utils/navigation'
import { chosenRoomsOf, searchRequestOf, type StayForm } from '../app/utils/stay'

const form: StayForm = { hotelId: 'h', checkIn: '2027-06-01', checkOut: '2027-06-04', bookingType: 'FAMILY', totalCount: 4, maleCount: 2, femaleCount: 1, childCount: 1, infantCount: 1, childSide: 'MOTHER' }

describe('the booking form', () => {
  it('a family sends its total; a group its sides, its total being their sum, and the children\'s side only with children', () => {
    expect(searchRequestOf(form)).toEqual({ hotelId: 'h', bookingType: 'FAMILY', checkIn: '2027-06-01', checkOut: '2027-06-04', infantCount: 1, totalCount: 4 })
    expect(searchRequestOf({ ...form, bookingType: 'GROUP' })).toMatchObject({ maleCount: 2, femaleCount: 1, childCount: 1, totalCount: 4, childSide: 'MOTHER' })
    expect(searchRequestOf({ ...form, bookingType: 'GROUP', childCount: 0 })).not.toHaveProperty('childSide')
  })

  it('the chosen option goes back as its rooms only', () => {
    const option = { rooms: [{ roomId: 'r', roomNumber: '101', floorLevel: 1, roomTypeId: 't', occupancy: 'FAMILY' as const, seats: 4, extraBeds: 0, existing: false }], newRooms: 1, emptySeats: 0, extraBeds: 0, totalHalalas: 1, priceSource: 'PUBLIC' as const }
    expect(chosenRoomsOf(option)).toEqual([{ roomId: 'r', occupancy: 'FAMILY', seats: 4, extraBeds: 0 }])
  })

  it('after sign-in it returns only to a path of this site', () => {
    expect(safeRedirect('/bookings/1', '/bookings')).toBe('/bookings/1')
    expect(safeRedirect('//evil.example')).toBe('/')
    expect(safeRedirect('https://evil.example')).toBe('/')
    expect(safeRedirect('/\\evil.example')).toBe('/')
    expect(safeRedirect('/\t/evil.example')).toBe('/')
    expect(safeRedirect('/\n/evil.example')).toBe('/')
    expect(safeRedirect('/bookings?page=2')).toBe('/bookings?page=2')
    expect(safeRedirect(undefined)).toBe('/')
  })
})
