/**
 * The occupancy calendar's response shapes (v7 §14): a range of days for the year and month views, one day in full
 * (floors, rooms, the bookings sleeping there) for the day view. Shared by the API and the ops console.
 */
import type { AgeGroup, BookingStatus, BookingType, GuestStatus, Occupancy } from '../constants/booking'
import type { CapacityPeriodKind, InventoryStatus } from '../constants/inventory'
import type { IsoDate, NightRange } from '../utils/dates'

/** How a room looks on one night (v7 §14 legend). */
export const ROOM_NIGHT_STATES = ['FULL', 'PARTIAL', 'HELD', 'EMPTY', 'BLOCKED'] as const
export type RoomNightState = typeof ROOM_NIGHT_STATES[number]

export interface DayTotals {
  rooms: { total: number, full: number, partial: number, held: number, empty: number, blocked: number }
  /**
   * `total` = the sellable seats; `empty` = what is still free in sellable rooms. `pilgrims` and `held` count every
   * seated person, also in a room blocked after they were booked (so they may exceed `total - empty`).
   */
  seats: { total: number, pilgrims: number, held: number, empty: number }
  /** Seats taken (pilgrims and holds) of the sellable seats, whole percent, at most 100. */
  occupancyPercent: number
}

/** One day of the year and month views: rooms by state, seats, fill, arrivals and departures. */
export interface OccupancyDayDto extends DayTotals {
  date: IsoDate
  arrivals: number
  departures: number
}

export interface OccupancyRangeDto {
  range: NightRange
  today: IsoDate
  /** Capacity periods in the range (Hajj and Ramadan are marked on the year view). */
  periods: Array<{ id: string, name: string, kind: CapacityPeriodKind, startDate: IsoDate, endDate: IsoDate }>
  days: OccupancyDayDto[]
}

/** A pilgrim on the day view: the name only for viewers with `pilgrim.view`, never a passport number. */
export interface OccupancyGuestDto { guestId: string, slotNo: number, ageGroup: AgeGroup, status: GuestStatus, name: string | null, detailsComplete: boolean }

export interface OccupancyClaimDto {
  bookingId: string
  bookingNo: string
  status: BookingStatus
  bookingType: BookingType
  /** An agency (with its name), or an individual / family booker (`agencyId` null). */
  booker: { agencyId: string | null, name: string | null }
  occupancy: Occupancy
  checkIn: IsoDate
  checkOut: IsoDate
  extraBeds: number
  guests: OccupancyGuestDto[]
}

export interface OccupancyRoomDto {
  roomId: string
  roomNumber: string
  roomType: { id: string, name: string }
  inventoryStatus: InventoryStatus
  state: RoomNightState
  capacity: number
  booked: number
  held: number
  claims: OccupancyClaimDto[]
}

export interface OccupancyFloorDto { id: string, level: number, label: string, rooms: OccupancyRoomDto[] }

/** Seated pilgrims and rooms of one booker that night; `agencyId` null = individuals and families together. */
export interface OccupancyBookerDto { agencyId: string | null, name: string | null, pilgrims: number, rooms: number }

export interface OccupancyDayViewDto {
  date: IsoDate
  today: IsoDate
  summary: OccupancyDayDto & { detailsPending: number, byBooker: OccupancyBookerDto[] }
  floors: OccupancyFloorDto[]
}
