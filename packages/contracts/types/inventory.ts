/** The inventory API's response shapes: averages (Task 17), daily summaries (Task 18), seasons (Task 15). */
import type { CapacityPeriodKind, PeriodPhase } from '../constants/inventory'
import type { IsoDate, NightRange } from '../utils/dates'

/** Every average the API returns. `value`/`display` are `null` exactly when `denominator` is 0 — never 0, NaN or Infinity. */
export interface AverageDto {
  numerator: number
  denominator: number
  value: number | null
  display: string | null
  basis: 'ROOMS' | 'ROOM_NIGHTS'
}

export interface RangeAverageDto extends AverageDto { from: IsoDate, to: IsoDate }

export interface AvailableStayDto extends AverageDto {
  checkIn: IsoDate
  checkOut: IsoDate
  /** Always present and exact. */
  eligibleRoomCount: number
  /**
   * Only with `includeRoomIds=true`; at most `MAX_ELIGIBLE_ROOM_IDS` ids, in room-number order. The list was capped
   * exactly when `eligibleRoomIds.length < eligibleRoomCount`.
   */
  eligibleRoomIds?: string[]
}

export interface HotelAveragesDto {
  hotelId: string
  /** The date `base` and `dateEffective` were evaluated on: the explicit `date`, else the hotel-local today. */
  date: IsoDate
  base: AverageDto
  dateEffective: AverageDto
  /** Only when `from`/`to` were given. */
  range: RangeAverageDto | null
  /** Only when `stayCheckIn`/`stayCheckOut` were given. */
  availableStay: AvailableStayDto | null
}

export interface PerHotelAveragesDto {
  hotelId: string
  code: string
  name: string
  /** The date this hotel was evaluated on (its own local today when no `date` was given — S12). */
  date: IsoDate
  base: AverageDto
  dateEffective: AverageDto
}

export interface OrganizationAveragesDto {
  /** The explicit `date`, or `null` when each hotel was evaluated on its own local today (S12). */
  date: IsoDate | null
  base: AverageDto
  dateEffective: AverageDto
  perHotel: PerHotelAveragesDto[]
}

/** One night of a hotel's inventory: rooms in it, how many can be sold, and the capacity they carry. */
export interface DailySummary {
  date: IsoDate
  roomsInInventory: number
  sellableRooms: number
  outOfService: number
  maintenance: number
  operationalBlock: number
  effectiveSellableCapacity: number
  sellableRoomCapacity: number
}

/** `today` is the hotel-local today; `maintenanceBlocksSales` is the resolved hotel setting. */
export interface CalendarMetaDto {
  today: IsoDate
  maintenanceBlocksSales: boolean
}

export interface DailySummaryDto {
  range: NightRange
  meta: CalendarMetaDto
  /** One row per date of the inclusive range, in date order. */
  days: DailySummary[]
}

export type { PeriodPhase }

/** A season (S7): its phase, nights, how many rooms it changes and by how much on its first night. */
export interface CapacityPeriodDto {
  id: string
  name: string
  kind: CapacityPeriodKind
  startDate: IsoDate
  endDate: IsoDate
  notes: string | null
  phase: PeriodPhase
  nights: number
  overrideCount: number
  impact: { sellableDelta: number, bedsDelta: number }
}
