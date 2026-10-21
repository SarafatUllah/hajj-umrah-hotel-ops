import type { HotelStatus, OwnershipType } from '@hajj/contracts/constants/inventory'
import type { IsoDate } from '@hajj/contracts/utils/dates'
import type { HotelRow } from '../repositories/tenant'
import type { HotelSummary, HotelDetail } from '@hajj/contracts/types/hotel'

export type { HotelSummary, HotelDetail }

/** Postgres `time` reads back as HH:MM:SS; the API speaks HH:MM (minutes are a hotel's precision). */
export const asMinutes = (time: string): string => time.slice(0, 5)

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
    checkInTime: asMinutes(hotel.checkInTime),
    checkOutTime: asMinutes(hotel.checkOutTime),
    ownershipType: hotel.ownershipType as OwnershipType,
    licenseReference: hotel.licenseReference,
    notes: hotel.notes,
    createdAt: hotel.createdAt.toISOString(),
    updatedAt: hotel.updatedAt.toISOString(),
  }
}
