/** The inventory API's response shapes: averages (Task 17), daily summaries (Task 18), seasons (Task 15). */
import type { BlockKind, CapacityPeriodKind, InventoryStatus, PeriodPhase } from '../constants/inventory'
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

/** A season as other shapes name it. */
export interface PeriodRef { id: string, name: string, kind: CapacityPeriodKind, startDate: IsoDate, endDate: IsoDate }

/** Beds and Haji capacity: always the two numbers, never one (§1.4). */
export interface CapacityValues { physicalBeds: number, sellableCapacity: number }

export type CapacitySource = 'BASE' | 'PERIOD_OVERRIDE'

/** A room's capacity over consecutive nights, and where it comes from (its normal capacity, or a season). */
export interface CapacitySegment extends NightRange, CapacityValues { source: CapacitySource, periodId: string | null }

/** A room's capacity over a window (`GET …/rooms/:id/capacity-timeline`); nights out of inventory have no segment. */
export interface CapacityTimelineResult {
  range: { from: IsoDate, to: IsoDate }
  meta: { today: IsoDate }
  segments: CapacitySegment[]
  refs: { periods: Record<string, PeriodRef> }
}

/** One room's seasonal capacity in a season. */
export interface OverrideListItem { id: string, roomId: string, roomNumber: string, physicalBeds: number, sellableCapacity: number, reason: string | null, createdAt: string }

/** Why a room the selection named would not take the season's capacity. */
export type SkipReason = 'NOT_IN_INVENTORY_FOR_PERIOD' | 'ALREADY_OVERRIDDEN'
export interface AppliedOverridePlan { roomId: string, roomNumber: string, before: CapacityValues, after: CapacityValues }
export interface SkippedOverridePlan { roomId: string, roomNumber: string, reason: SkipReason }
export interface OverridePlan { applied: AppliedOverridePlan[], skipped: SkippedOverridePlan[] }
export interface OverridePreviewTotals { rooms: number, bedsBefore: number, bedsAfter: number, sellableBefore: number, sellableAfter: number }
export interface OverrideHotelTotals { roomsInInventory: number, sellableBefore: number, sellableDuring: number }

/** What applying would do (S6), measured on the season's first night — nothing is written. */
export interface OverridePreview extends OverridePlan { totals: OverridePreviewTotals, hotelTotals: OverrideHotelTotals }

/** A room's inventory over consecutive nights (Task 18): status, capacity and its source, the blocks behind it. */
export interface CalendarSegment {
  from: IsoDate
  to: IsoDate
  status: InventoryStatus
  /** Can the room be sold on these nights (in inventory and not covered by a sale-blocking block)? */
  sellable: boolean
  physicalBeds: number | null
  sellableCapacity: number | null
  capacitySource: CapacitySource | null
  periodId: string | null
  blockIds: string[]
  /** The live bookings holding the room on these nights (named in `refs.bookings`), whatever the status shown. */
  bookingIds: string[]
}

export interface CalendarRoomDto {
  roomId: string
  roomNumber: string
  floor: { id: string, level: number, label: string }
  roomType: { id: string, code: string, name: string }
  features: string[]
  /** Run-length encoded, covering the whole requested range exactly (no gap, no overlap). */
  segments: CalendarSegment[]
}

export interface CalendarRefsDto {
  periods: Record<string, { name: string, kind: CapacityPeriodKind, startDate: IsoDate, endDate: IsoDate }>
  blocks: Record<string, { kind: BlockKind, startDate: IsoDate, endDate: IsoDate, reason: string }>
  /** A booking: its number, who holds it (the agency's name, or null for a customer), its stay `[checkIn, checkOut)`. */
  bookings: Record<string, { bookingNo: string, agencyName: string | null, checkIn: IsoDate, checkOut: IsoDate }>
}

/** A page of the room calendar (S13): EXACTLY the periods and blocks this page's segments reference are in `refs`. */
export interface RoomCalendarDto {
  range: NightRange
  page: number
  pageSize: number
  /** Rooms matching every filter (before paging) — exact. */
  total: number
  meta: CalendarMetaDto
  refs: CalendarRefsDto
  rooms: CalendarRoomDto[]
}
