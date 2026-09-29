import type { HotelStatus, OwnershipType } from '../../shared/constants/inventory'
import type { IsoDate } from '../../shared/utils/dates'
import type { HotelRow } from '../repositories/tenant'

/**
 * `HotelSummary` — the hotel switcher's data (also every item of `GET /api/hotels`).
 * `floorCount`/`roomCount` are `null` in this task (Task 13/14 fill them in) and are also `null`
 * whenever the caller lacks `room.view` (PF-13) — the service computes both via `hotelExtras` and
 * hands them in already resolved, so this mapper never has to know about permissions itself.
 */
export interface HotelSummary {
  id: string
  code: string
  name: string
  city: string
  country: string
  status: HotelStatus
  timezone: string
  today: IsoDate
  floorCount: number | null
  roomCount: number | null
}

export interface HotelDetail extends HotelSummary {
  address: string | null
  phone: string | null
  email: string | null
  currency: string
  checkInTime: string
  checkOutTime: string
  ownershipType: OwnershipType
  licenseReference: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface HotelDtoExtras {
  today: IsoDate
  floorCount: number | null
  roomCount: number | null
}

export function toHotelSummary(hotel: HotelRow, extras: HotelDtoExtras): HotelSummary {
  return {
    id: hotel.id,
    code: hotel.code,
    name: hotel.name,
    city: hotel.city,
    country: hotel.country,
    status: hotel.status as HotelStatus,
    timezone: hotel.timezone,
    today: extras.today,
    floorCount: extras.floorCount,
    roomCount: extras.roomCount,
  }
}

export function toHotelDetail(hotel: HotelRow, extras: HotelDtoExtras): HotelDetail {
  return {
    ...toHotelSummary(hotel, extras),
    address: hotel.address,
    phone: hotel.phone,
    email: hotel.email,
    currency: hotel.currency,
    checkInTime: hotel.checkInTime,
    checkOutTime: hotel.checkOutTime,
    ownershipType: hotel.ownershipType as OwnershipType,
    licenseReference: hotel.licenseReference,
    notes: hotel.notes,
    createdAt: hotel.createdAt.toISOString(),
    updatedAt: hotel.updatedAt.toISOString(),
  }
}
