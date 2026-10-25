import type { OwnershipType } from '@hajj/contracts/constants/inventory'
import type { CreateHotelInput, UpdateHotelInput } from '@hajj/contracts/schemas/hotel'
import type { HotelDetail } from '@hajj/contracts/types/hotel'

/** The hotel form as people fill it (§24): every field a string, optional ones empty when not given. */
export interface HotelForm {
  code: string
  name: string
  city: string
  country: string
  address: string
  phone: string
  email: string
  timezone: string
  currency: string
  checkInTime: string
  checkOutTime: string
  licenseReference: string
  ownershipType: OwnershipType
  notes: string
}

const OPTIONAL = ['address', 'phone', 'email', 'licenseReference', 'notes'] as const
type OptionalField = typeof OPTIONAL[number]
const isOptional = (key: string): key is OptionalField => (OPTIONAL as readonly string[]).includes(key)

/** A new hotel's starting values (§24): Saudi Arabia, Riyadh time, riyals, check-in 15:00, check-out 12:00, owned. */
export function emptyHotelForm(): HotelForm {
  return { code: '', name: '', city: '', country: 'SA', address: '', phone: '', email: '', timezone: 'Asia/Riyadh', currency: 'SAR', checkInTime: '15:00', checkOutTime: '12:00', licenseReference: '', ownershipType: 'OWNED', notes: '' }
}

/** A hotel as the edit form shows it. */
export function hotelFormOf(hotel: HotelDetail): HotelForm {
  return {
    code: hotel.code, name: hotel.name, city: hotel.city, country: hotel.country, address: hotel.address ?? '', phone: hotel.phone ?? '',
    email: hotel.email ?? '', timezone: hotel.timezone, currency: hotel.currency, checkInTime: hotel.checkInTime, checkOutTime: hotel.checkOutTime,
    licenseReference: hotel.licenseReference ?? '', ownershipType: hotel.ownershipType, notes: hotel.notes ?? '',
  }
}

/** `POST /api/hotels`: the code upper-cased, optional details left out when empty. */
export function createRequestOf(form: HotelForm): CreateHotelInput {
  const entries = Object.entries({ ...form, code: form.code.trim().toUpperCase() })
    .filter(([key, value]) => !(isOptional(key) && value.trim() === ''))
  return Object.fromEntries(entries) as CreateHotelInput
}

/** `PATCH /api/hotels/:id`: only the fields that changed (never the code); an optional detail emptied is `null`. */
export function updateRequestOf(form: HotelForm, hotel: HotelDetail): UpdateHotelInput {
  const before = hotelFormOf(hotel)
  const changed = (Object.keys(form) as Array<keyof HotelForm>)
    .filter(key => key !== 'code' && form[key] !== before[key])
    .map(key => [key, isOptional(key) && form[key].trim() === '' ? null : form[key]])
  return Object.fromEntries(changed) as UpdateHotelInput
}
