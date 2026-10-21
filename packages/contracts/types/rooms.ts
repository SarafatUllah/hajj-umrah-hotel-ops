/** The rooms and blocks API's response shapes (Phase 1 tasks 14–16; UI-UX-MASTER-DIRECTION §42 S5, S10, S11). */
import type { BaseConfigOrigin, BlockKind, BlockPhase, InventoryStatus, PeriodPhase, RoomFeature } from '../constants/inventory'
import type { IsoDate } from '../utils/dates'
import type { CapacityValues, PeriodRef } from './inventory'

export interface EffectiveCapacityDto extends CapacityValues { source: 'BASE' | 'PERIOD_OVERRIDE', period: PeriodRef | null }

/** The first night after `asOf` (within 400 nights) where the room's capacity, its source or its inventory changes. */
export type NextChangeDto =
  | { kind: 'CAPACITY' | 'ENTERS_INVENTORY', date: IsoDate, capacity: EffectiveCapacityDto }
  | { kind: 'LEAVES_INVENTORY', date: IsoDate }

export interface RoomListItem {
  id: string
  roomNumber: string
  floor: { id: string, level: number, label: string }
  roomType: { id: string, code: string, name: string }
  features: RoomFeature[]
  asOf: IsoDate
  inInventory: boolean
  /** `inServiceFrom` = the first version's `validFrom`; `lastNight` = the latest version's `validTo` (`null` = open-ended). */
  lifecycle: { inServiceFrom: IsoDate, lastNight: IsoDate | null }
  base: CapacityValues | null
  effective: EffectiveCapacityDto | null
  status: InventoryStatus
  nextChange: NextChangeDto | null
}

export interface RoomDetail extends RoomListItem {
  notes: string | null
  createdAt: string
  updatedAt: string
  /** Full history, oldest first. */
  baseVersions: Array<{ id: string, validFrom: IsoDate, validTo: IsoDate | null, physicalBeds: number, sellableCapacity: number, origin: BaseConfigOrigin, reason: string | null, createdAt: string }>
  /** Every season this room has its own capacity in. */
  seasons: Array<{ overrideId: string, period: PeriodRef & { phase: PeriodPhase }, physicalBeds: number, sellableCapacity: number }>
}

export interface RoomListPage {
  items: RoomListItem[]
  page: number
  pageSize: number
  total: number
}

export type { BlockPhase }

export interface BlockActor { id: string, fullName: string }

/**
 * S10/S11 block list item — the shape of the list, create and cancel responses. `phase` (display) and
 * `cancelAction` (which confirmation the UI offers) are computed with the hotel's today; the UI never compares dates
 * to decide either. A block starting tonight is `phase: 'RUNNING'` yet `cancelAction: 'CANCEL'` (start >= today ->
 * full cancel).
 */
export interface BlockListItem {
  id: string
  room: { id: string, roomNumber: string }
  kind: BlockKind
  startDate: IsoDate
  /** The block's ACTUAL last night (after an early end, the shortened one; the plan is in `endedEarly.originalEndDate`). */
  endDate: IsoDate
  nights: number
  reason: string
  phase: BlockPhase
  cancelAction: 'CANCEL' | 'END_EARLY' | null
  createdBy: BlockActor | null
  createdAt: string
  /** Cancellation only — all three are `null` for a block that was ended early (that is reported under `endedEarly`). */
  cancelledAt: string | null
  cancelledBy: BlockActor | null
  cancelReason: string | null
  /** S11: visible to everyone who can see the block (not only `audit.view` holders). */
  endedEarly: { at: string, by: BlockActor | null, originalEndDate: IsoDate, reason: string } | null
}

export interface BlockListPage {
  items: BlockListItem[]
  page: number
  pageSize: number
  total: number
}

/** Why a room of a bulk block could not take it (409 `BLOCK_CONFLICT`, `details.conflicts`). */
export interface BlockConflict { roomId: string, roomNumber: string, reason: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK' | 'BLOCK_OVERLAP' }
