import type { BaseConfigOrigin, CapacityPeriodKind, InventoryStatus, RoomFeature } from '../../shared/constants/inventory'
import { type IsoDate, toEpochDay } from '../../shared/utils/dates'
import { type BaseVersion, type CapacityOverride, baseCapacityAt, effectiveCapacityAt } from '../domain/inventory/capacity'
import { type CalendarOptions, buildRoomSegments } from '../domain/inventory/calendar'
import { type PeriodPhase, periodPhase } from '../domain/inventory/capacityPeriodRules'
import { nextCapacityChange, type NextChangeCapacity } from '../domain/inventory/nextChange'
import type { FloorRow, RoomBaseConfigRow, RoomCapacityOverrideRow, RoomRow } from '../repositories/hotel'
import type { RoomTypeRow } from '../repositories/tenant'

export type { PeriodPhase }
export interface PeriodRef { id: string, name: string, kind: CapacityPeriodKind, startDate: IsoDate, endDate: IsoDate }
export interface CapacityValues { physicalBeds: number, sellableCapacity: number }
export interface EffectiveCapacityDto extends CapacityValues { source: 'BASE' | 'PERIOD_OVERRIDE', period: PeriodRef | null }
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
  /** Task 15 fills this from real capacity-period overrides; always `[]` in Task 14. */
  seasons: Array<{ overrideId: string, period: PeriodRef & { phase: PeriodPhase }, physicalBeds: number, sellableCapacity: number }>
}

/** No operational blocks exist yet (Task 16 supplies them). */
const NO_BLOCKS: never[] = []
/** `maintenanceBlocksSales` is irrelevant with zero blocks (Task 16 supplies the real hotel setting); a fixed value keeps `buildRoomSegments`' call shape stable. */
const CALENDAR_OPTIONS: CalendarOptions = { maintenanceBlocksSales: true }

export function toBaseVersion(row: RoomBaseConfigRow): BaseVersion {
  return { validFrom: row.validFrom, validTo: row.validTo, physicalBeds: row.physicalBeds, sellableCapacity: row.sellableCapacity }
}

/** `CapacityOverride` (the pure domain shape) from a persisted override row — drops `id`/`organizationId`/etc., which the domain layer never needs. */
export function toCapacityOverride(row: RoomCapacityOverrideRow): CapacityOverride {
  return { periodId: row.periodId, validFrom: row.validFrom, validTo: row.validTo, physicalBeds: row.physicalBeds, sellableCapacity: row.sellableCapacity }
}

function toEffectiveCapacityDto(cap: { physicalBeds: number, sellableCapacity: number, source: 'BASE' | 'PERIOD_OVERRIDE', periodId: string | null } | NextChangeCapacity, periodRefs: Map<string, PeriodRef>): EffectiveCapacityDto {
  return { physicalBeds: cap.physicalBeds, sellableCapacity: cap.sellableCapacity, source: cap.source, period: cap.periodId ? (periodRefs.get(cap.periodId) ?? null) : null }
}

function toNextChangeDto(next: ReturnType<typeof nextCapacityChange>, periodRefs: Map<string, PeriodRef>): NextChangeDto | null {
  if (!next) return null
  if (next.kind === 'LEAVES_INVENTORY') return next
  return { kind: next.kind, date: next.date, capacity: toEffectiveCapacityDto(next.capacity, periodRefs) }
}

function lifecycleOf(versions: BaseVersion[]): { inServiceFrom: IsoDate, lastNight: IsoDate | null } {
  const sorted = [...versions].sort((a, b) => toEpochDay(a.validFrom) - toEpochDay(b.validFrom))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  return { inServiceFrom: first?.validFrom ?? '', lastNight: last?.validTo ?? null }
}

export interface RoomDtoRefs {
  room: RoomRow
  floor: Pick<FloorRow, 'id' | 'level' | 'label'>
  roomType: Pick<RoomTypeRow, 'id' | 'code' | 'name'>
  versions: BaseVersion[]
  /** Every override relevant to the capacity computed here (never filtered narrower than the caller's own window needs — see `roomService.ts`'s callers for what each one fetches). */
  overrides: CapacityOverride[]
  /** Resolved `PeriodRef`s for every `periodId` appearing in `overrides`, keyed by period id. */
  periodRefs: Map<string, PeriodRef>
  asOf: IsoDate
}

export function toRoomListItem(refs: RoomDtoRefs): RoomListItem {
  const { room, floor, roomType, versions, overrides, periodRefs, asOf } = refs
  const base = baseCapacityAt(versions, asOf)
  const effective = effectiveCapacityAt(versions, overrides, asOf)
  const segments = buildRoomSegments({ roomId: room.id, versions, overrides, blocks: NO_BLOCKS }, { from: asOf, to: asOf }, CALENDAR_OPTIONS)
  const status = segments[0]!.status

  return {
    id: room.id,
    roomNumber: room.roomNumber,
    floor: { id: floor.id, level: floor.level, label: floor.label },
    roomType: { id: roomType.id, code: roomType.code, name: roomType.name },
    features: room.features as RoomFeature[],
    asOf,
    inInventory: status !== 'NOT_IN_INVENTORY',
    lifecycle: lifecycleOf(versions),
    base,
    effective: effective ? toEffectiveCapacityDto(effective, periodRefs) : null,
    status,
    nextChange: toNextChangeDto(nextCapacityChange(versions, overrides, asOf), periodRefs),
  }
}

export function toRoomDetail(refs: RoomDtoRefs & { baseVersionRows: RoomBaseConfigRow[], overrideRows: RoomCapacityOverrideRow[], today: IsoDate }): RoomDetail {
  const listItem = toRoomListItem(refs)
  const sortedRows = [...refs.baseVersionRows].sort((a, b) => a.validFrom.localeCompare(b.validFrom))
  const sortedOverrideRows = [...refs.overrideRows].sort((a, b) => a.validFrom.localeCompare(b.validFrom))

  return {
    ...listItem,
    notes: refs.room.notes,
    createdAt: refs.room.createdAt.toISOString(),
    updatedAt: refs.room.updatedAt.toISOString(),
    baseVersions: sortedRows.map(row => ({
      id: row.id,
      validFrom: row.validFrom,
      validTo: row.validTo,
      physicalBeds: row.physicalBeds,
      sellableCapacity: row.sellableCapacity,
      origin: row.origin as BaseConfigOrigin,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    seasons: sortedOverrideRows.flatMap((row) => {
      const period = refs.periodRefs.get(row.periodId)
      if (!period) return [] // structurally impossible (composite FK) — defensive, never silently fabricates a period ref
      return [{
        overrideId: row.id,
        period: { ...period, phase: periodPhase(period, refs.today) },
        physicalBeds: row.physicalBeds,
        sellableCapacity: row.sellableCapacity,
      }]
    }),
  }
}
