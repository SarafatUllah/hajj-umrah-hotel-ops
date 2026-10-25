import { describe, expect, it } from 'vitest'
import type { HotelDetail } from '@hajj/contracts/types/hotel'
import { createRequestOf, emptyHotelForm, hotelFormOf, updateRequestOf } from '../app/utils/hotelForm'

const hotel: HotelDetail = {
  id: 'h', code: 'MKK-GRAND', name: 'Grand', city: 'Makkah', country: 'SA', status: 'ACTIVE', timezone: 'Asia/Riyadh', today: '2026-10-21',
  floorCount: 1, roomCount: 2, address: 'Ajyad St', phone: null, email: 'desk@grand.test', currency: 'SAR', checkInTime: '15:00',
  checkOutTime: '12:00', ownershipType: 'OWNED', licenseReference: null, notes: null, createdAt: '', updatedAt: '',
}

describe('the hotel form', () => {
  it('a new hotel starts with the defaults; its request leaves out what was not filled in, the code upper-cased', () => {
    expect(emptyHotelForm()).toMatchObject({ country: 'SA', timezone: 'Asia/Riyadh', currency: 'SAR', checkInTime: '15:00', checkOutTime: '12:00', ownershipType: 'OWNED' })
    const request = createRequestOf({ ...emptyHotelForm(), code: 'mkk-quba', name: ' Quba ', city: 'Madinah', phone: '  ' })
    expect(request).toMatchObject({ code: 'MKK-QUBA', name: ' Quba ', city: 'Madinah' })
    expect(request).not.toHaveProperty('phone')
    expect(request).not.toHaveProperty('address')
  })

  it('an edit sends only what changed, a cleared detail as null', () => {
    const form = { ...hotelFormOf(hotel), city: 'Makkah', address: '', notes: 'Near the Haram' }
    expect(updateRequestOf(form, hotel)).toEqual({ address: null, notes: 'Near the Haram' })
    expect(updateRequestOf(hotelFormOf(hotel), hotel)).toEqual({})
  })
})
