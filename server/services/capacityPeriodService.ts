import type { CapacityPeriodKind } from '../../shared/constants/inventory'
import type {
  ApplyOverridesInput,
  CapacityTimelineQuery,
  CreateCapacityPeriodInput,
  ListCapacityPeriodsQuery,
  OverrideSelector,
  RemoveOverridesInput,
  UpdateCapacityPeriodInput,
} from '../../shared/schemas/capacityPeriod'
import { InvalidRangeError, type IsoDate, type NightRange, rangeLength, todayInTimezone } from '../../shared/utils/dates'
import { type BaseVersion, baseCapacityAt, type CapacitySegment, capacitySegments, effectiveCapacityAt } from '../domain/inventory/capacity'
import { assertOverridesChangeable, assertPeriodDeletable, assertPeriodPatchAllowed, assertPeriodRange, computeOverrideValues, periodPhase, type PeriodPhase } from '../domain/inventory/capacityPeriodRules'
import { InventoryRuleError } from '../domain/inventory/rules'
import { extractPgError, translateDbError } from '../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../errors/domainError'
import { hotelRepos, tenantRepos } from '../repositories'
import type { CapacityPeriodPatch, CapacityPeriodRow, RoomBaseConfigRow, RoomCapacityOverrideRow, RoomRow } from '../repositories/hotel'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel } from '../security/authorize'
import { recordAudit } from './audit'
import { type CapacityValues, type PeriodRef, toBaseVersion, toCapacityOverride } from './roomDto'

/**
 * Rethrows a caught `InventoryRuleError` as the matching HTTP-mapped `DomainError`. Also catches
 * `InvalidRangeError` — `assertPeriodRange`'s `makeRange(startDate, endDate)` throws this (a plain
 * `shared/utils/dates` error, NOT an `InventoryRuleError`) when `endDate` is before `startDate`; the
 * `createCapacityPeriodSchema` catches this for CREATE at the schema layer already, but an UPDATE
 * patch can still produce an inverted range (e.g. patching only `endDate` before the period's
 * existing `startDate`) that only `assertPeriodRange` itself can detect — without this branch it
 * would leak as an unhandled 500 instead of a 422. Anything else is rethrown unchanged.
 */
function rethrowAsDomainError(error: unknown): never {
  if (error instanceof InventoryRuleError) {
    throw error.kind === 'conflict' ? new ConflictError(error.code, error.message) : new ValidationError(error.code, error.message)
  }
  if (error instanceof InvalidRangeError) {
    throw new ValidationError('INVALID_DATE_RANGE', error.message)
  }
  throw error
}

/**
 * Translates the database error of an override write (apply's insert, a period date edit's FK
 * cascade). Besides the registry-driven `translateDbError`, a deadlock (40P01) is the exclusion race
 * resolved by PostgreSQL itself: when two transactions write conflicting override ranges for the same
 * room at the same instant, each one's `room_override_no_overlap` check waits on the other's
 * in-progress row, and PostgreSQL aborts one of them with 40P01 instead of 23P01 (reproduced on
 * PostgreSQL 16). The aborted transaction wrote nothing — it is simply the race's loser, so it gets the
 * same 409 `RANGE_OVERLAP` a 23P01 loser gets instead of an untranslated 500.
 */
function translateOverrideWriteError(error: unknown): unknown {
  if (extractPgError(error)?.code === '40P01') {
    return new ConflictError('RANGE_OVERLAP', 'A concurrent change gave a room a capacity override on the same nights; nothing was saved')
  }
  return translateDbError(error) ?? error
}

function groupByRoomId<T extends { roomId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const r of rows) map.set(r.roomId, [...(map.get(r.roomId) ?? []), r])
  return map
}

function groupByPeriodId<T extends { periodId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const r of rows) map.set(r.periodId, [...(map.get(r.periodId) ?? []), r])
  return map
}

/**
 * The period scoped to the ALREADY-authorized `HotelScope`. `forUpdate` (inside a transaction only)
 * row-locks it — see `CapacityPeriodRepository.findById` for why the period row is the serialization
 * point between `applyOverrides` and `updateCapacityPeriod`.
 */
async function loadPeriodInScope(hotelScoped: ReturnType<typeof hotelRepos>, periodId: string, options: { forUpdate?: boolean } = {}): Promise<CapacityPeriodRow> {
  const row = await hotelScoped.capacityPeriods.findById(periodId, options)
  if (!row) throw new NotFoundError('CAPACITY_PERIOD_NOT_FOUND')
  return row
}

/**
 * The single inventory-coverage rule for overrides, shared by override apply (`planOverrideApplication`)
 * and period date edits (`assertOverriddenRoomsCoverRange`): the base-only coverage (no overrides)
 * over `range` must sum to exactly the range's length — any gap (not yet commissioned, retired before
 * the range ends) means partial or zero coverage.
 */
function coversEveryNight(versions: BaseVersion[], range: NightRange): boolean {
  const coverage = capacitySegments(versions, [], range)
  const coveredNights = coverage.reduce((n, s) => n + rangeLength(s), 0)
  return coveredNights === rangeLength(range)
}

/**
 * Period date edit guard (N1). A date edit moves every override row of the period with it (the
 * `(period_id, valid_from, valid_to)` FK cascades), so each room holding an override on this period
 * must be in inventory for EVERY night of the CANDIDATE range — exactly the rule an override apply
 * enforces — or the cascade would silently stretch an override onto nights with no base version
 * underneath (e.g. after the room's retirement).
 *
 * The caller must already hold the period row lock (`loadPeriodInScope(..., { forUpdate: true })`):
 * `applyOverrides` takes the same lock first, so no override can be added to this period while this
 * runs. The overridden rooms are then row-locked (`rooms.lockByIds`, ascending-id order — the same
 * lock `retireRoom` takes), and the overrides and base versions are re-read AFTER that lock, so the
 * check sees any retirement that committed while this transaction waited. A room whose override is
 * read here but whose row is somehow not locked has no versions in the map and therefore fails the
 * check (fail-closed). Issues no write: on any uncovered room it throws before the caller writes
 * anything. A period with no overrides costs exactly one query and takes no room lock.
 */
async function assertOverriddenRoomsCoverRange(hotelScoped: ReturnType<typeof hotelRepos>, periodId: string, range: NightRange): Promise<void> {
  const initial = await hotelScoped.roomCapacityOverrides.findByPeriod(periodId)
  if (initial.length === 0) return

  const lockedRooms = await hotelScoped.rooms.lockByIds(initial.map(o => o.roomId))
  const lockedIds = lockedRooms.map(r => r.id)
  const [overrides, versionRows] = await Promise.all([
    hotelScoped.roomCapacityOverrides.findByPeriod(periodId),
    hotelScoped.roomBaseConfigs.versionsForRooms(lockedIds),
  ])
  const versionsByRoom = groupByRoomId(versionRows)
  const overriddenRoomIds = new Set(overrides.map(o => o.roomId))
  const roomNumberById = new Map(lockedRooms.map(r => [r.id, r.roomNumber]))

  const conflicts: Array<{ roomId: string, roomNumber: string, reason: SkipReason }> = []
  for (const roomId of [...overriddenRoomIds].sort()) {
    const versions = (versionsByRoom.get(roomId) ?? []).map(toBaseVersion)
    if (!coversEveryNight(versions, range)) {
      conflicts.push({ roomId, roomNumber: roomNumberById.get(roomId) ?? '', reason: 'NOT_IN_INVENTORY_FOR_PERIOD' })
    }
  }

  if (conflicts.length > 0) {
    throw new ConflictError(
      'NOT_IN_INVENTORY_FOR_PERIOD',
      'One or more rooms with an override in this period are not in inventory for every night of the new dates; remove their overrides first or choose dates they cover',
      { conflicts },
    )
  }
}

// ---------------------------------------------------------------------------
// Period DTO (S7): phase/nights are computed, never stored; overrideCount and
// impact are always resolved from a FIXED number of batched queries — never
// one query per period, even when listing many.
// ---------------------------------------------------------------------------

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

function toPeriodDto(row: CapacityPeriodRow, overrideCount: number, impact: { sellableDelta: number, bedsDelta: number }, today: IsoDate): CapacityPeriodDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as CapacityPeriodKind,
    startDate: row.startDate,
    endDate: row.endDate,
    notes: row.notes,
    phase: periodPhase(row, today),
    nights: rangeLength({ from: row.startDate, to: row.endDate }),
    overrideCount,
    impact,
  }
}

/** Σ over `overrides` of (override − the room's base capacity on the PERIOD's first night). */
function computeImpact(period: CapacityPeriodRow, overrides: readonly RoomCapacityOverrideRow[], versionsByRoom: Map<string, RoomBaseConfigRow[]>): { sellableDelta: number, bedsDelta: number } {
  let sellableDelta = 0
  let bedsDelta = 0
  for (const o of overrides) {
    const versions = (versionsByRoom.get(o.roomId) ?? []).map(toBaseVersion)
    const base = baseCapacityAt(versions, period.startDate)
    if (!base) continue // structurally shouldn't happen (an applied override proved inventory coverage) — defensive only
    sellableDelta += o.sellableCapacity - base.sellableCapacity
    bedsDelta += o.physicalBeds - base.physicalBeds
  }
  return { sellableDelta, bedsDelta }
}

/** List periods (`room.view`). A FIXED number of statements regardless of how many periods exist: the list itself, one grouped override-count query, one unfiltered override query, one batched base-version query. */
export async function listCapacityPeriods(ctx: AuthContext, hotelId: string, query: ListCapacityPeriodsQuery): Promise<CapacityPeriodDto[]> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const today = todayInTimezone(hotel.timezone, ctx.now())

  const periods = await hotelScoped.capacityPeriods.list({ includePast: query.includePast, today })
  if (periods.length === 0) return []

  const [counts, allOverrides] = await Promise.all([
    hotelScoped.capacityPeriods.overrideCountsByPeriod(),
    hotelScoped.roomCapacityOverrides.listAll(),
  ])
  const roomIds = [...new Set(allOverrides.map(o => o.roomId))]
  const versionRows = await hotelScoped.roomBaseConfigs.versionsForRooms(roomIds)
  const versionsByRoom = groupByRoomId(versionRows)
  const overridesByPeriod = groupByPeriodId(allOverrides)

  return periods.map(p => toPeriodDto(p, counts.get(p.id) ?? 0, computeImpact(p, overridesByPeriod.get(p.id) ?? [], versionsByRoom), today))
}

export async function getCapacityPeriod(ctx: AuthContext, hotelId: string, periodId: string): Promise<CapacityPeriodDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const period = await loadPeriodInScope(hotelScoped, periodId)
  const today = todayInTimezone(hotel.timezone, ctx.now())

  const [overrideCount, overrides] = await Promise.all([
    hotelScoped.capacityPeriods.countOverrides(period.id),
    hotelScoped.roomCapacityOverrides.findByPeriod(period.id),
  ])
  const versionRows = await hotelScoped.roomBaseConfigs.versionsForRooms(overrides.map(o => o.roomId))
  const impact = computeImpact(period, overrides, groupByRoomId(versionRows))
  return toPeriodDto(period, overrideCount, impact, today)
}

export async function createCapacityPeriod(ctx: AuthContext, hotelId: string, input: CreateCapacityPeriodInput): Promise<CapacityPeriodDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)

  try {
    assertPeriodRange({ startDate: input.startDate, endDate: input.endDate })
  }
  catch (error) {
    rethrowAsDomainError(error)
  }

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)

    let created: CapacityPeriodRow
    try {
      created = await hotelScoped.capacityPeriods.insert({ name: input.name, kind: input.kind, startDate: input.startDate, endDate: input.endDate, notes: input.notes ?? null })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'capacity_period',
      entityId: created.id,
      action: 'CAPACITY_PERIOD_CREATED',
      before: null,
      after: created,
    })

    const today = todayInTimezone(hotel.timezone, ctx.now())
    return toPeriodDto(created, 0, { sellableDelta: 0, bedsDelta: 0 }, today)
  })
}

function diffPeriodFields(row: CapacityPeriodRow, patch: Record<string, unknown>): { before: Record<string, unknown>, after: Record<string, unknown>, changed: CapacityPeriodPatch } {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const changed: Record<string, unknown> = {}
  for (const [key, newValue] of Object.entries(patch)) {
    if (newValue === undefined) continue
    const oldValue = (row as unknown as Record<string, unknown>)[key]
    if (oldValue !== newValue) {
      before[key] = oldValue
      after[key] = newValue
      changed[key] = newValue
    }
  }
  return { before, after, changed: changed as unknown as CapacityPeriodPatch }
}

/**
 * Edits a period (`capacity.manage`) — `assertPeriodPatchAllowed` decides what is editable per phase.
 * A date edit that touches `startDate`/`endDate` cascades through the composite FK to every override
 * row of this period; a resulting overlap with another period's override for the same room surfaces
 * as `409 RANGE_OVERLAP` (translated from the exclusion constraint) with the WHOLE transaction (the
 * period's own update included) rolled back.
 *
 * A date change is also refused with `409 NOT_IN_INVENTORY_FOR_PERIOD` (`details.conflicts`) when any
 * room holding an override in this period would not be in inventory for every night of the NEW range
 * (N1 — `assertOverriddenRoomsCoverRange`); nothing is written. Lock order, identical to
 * `applyOverrides`: the period row first, then the overridden rooms (ascending id).
 */
export async function updateCapacityPeriod(ctx: AuthContext, hotelId: string, periodId: string, patch: UpdateCapacityPeriodInput): Promise<CapacityPeriodDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    // Period row lock FIRST (same position as in applyOverrides): no override can be added to this
    // period until this transaction ends, and `current` is the latest committed version of the row.
    const current = await loadPeriodInScope(hotelScoped, periodId, { forUpdate: true })
    const today = todayInTimezone(hotel.timezone, ctx.now())

    try {
      assertPeriodPatchAllowed(current, patch, today)
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    const candidate: Record<string, unknown> = {}
    if (patch.name !== undefined) candidate.name = patch.name
    if (patch.kind !== undefined) candidate.kind = patch.kind
    if (patch.startDate !== undefined) candidate.startDate = patch.startDate
    if (patch.endDate !== undefined) candidate.endDate = patch.endDate
    if (patch.notes !== undefined) candidate.notes = patch.notes

    const { before, after, changed } = diffPeriodFields(current, candidate)

    // N1: a real date change cascades to every override row of this period — every overridden room
    // must cover the CANDIDATE range. Validated for ALL rooms before any write below.
    if (changed.startDate !== undefined || changed.endDate !== undefined) {
      await assertOverriddenRoomsCoverRange(hotelScoped, current.id, { from: changed.startDate ?? current.startDate, to: changed.endDate ?? current.endDate })
    }

    let updatedRow = current
    if (Object.keys(changed).length > 0) {
      try {
        await hotelScoped.capacityPeriods.update(current.id, { ...changed, updatedAt: ctx.now() })
      }
      catch (error) {
        throw translateOverrideWriteError(error)
      }
      const refetched = await hotelScoped.capacityPeriods.findById(current.id)
      if (!refetched) throw new ConflictError('CAPACITY_PERIOD_NOT_FOUND', 'Capacity period no longer exists')
      updatedRow = refetched

      await recordAudit(tenant.audit, ctx.identity.userId, {
        hotelId: hotel.id,
        entityType: 'capacity_period',
        entityId: current.id,
        action: 'CAPACITY_PERIOD_UPDATED',
        before,
        after,
      })
    }

    const [overrideCount, overrides] = await Promise.all([
      hotelScoped.capacityPeriods.countOverrides(updatedRow.id),
      hotelScoped.roomCapacityOverrides.findByPeriod(updatedRow.id),
    ])
    const versionRows = await hotelScoped.roomBaseConfigs.versionsForRooms(overrides.map(o => o.roomId))
    const impact = computeImpact(updatedRow, overrides, groupByRoomId(versionRows))
    return toPeriodDto(updatedRow, overrideCount, impact, today)
  })
}

export async function deleteCapacityPeriod(ctx: AuthContext, hotelId: string, periodId: string): Promise<{ id: string }> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadPeriodInScope(hotelScoped, periodId)
    const today = todayInTimezone(hotel.timezone, ctx.now())

    const overrideCount = await hotelScoped.capacityPeriods.countOverrides(current.id)
    try {
      assertPeriodDeletable(current, overrideCount, today)
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    await hotelScoped.capacityPeriods.delete(current.id)

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'capacity_period',
      entityId: current.id,
      action: 'CAPACITY_PERIOD_DELETED',
      before: current,
      after: null,
    })

    return { id: current.id }
  })
}

// ---------------------------------------------------------------------------
// Override selector resolution
// ---------------------------------------------------------------------------

/** Resolves a validated selector into the set of rooms it names, scoped to this hotel — an id that doesn't belong here is a 422, never silently dropped. */
async function resolveSelectorRooms(hotelScoped: ReturnType<typeof hotelRepos>, tenant: ReturnType<typeof tenantRepos>, selector: OverrideSelector): Promise<RoomRow[]> {
  if ('all' in selector) return hotelScoped.rooms.listAll()

  // Each id list is validated in ONE scoped query (an id not returned does not belong here); the set
  // de-duplicates a direct service caller's repeats (the schema already does for HTTP callers).
  if ('floorIds' in selector) {
    const floorIds = [...new Set(selector.floorIds)]
    const floors = await hotelScoped.floors.findByIds(floorIds)
    if (floors.length !== floorIds.length) throw new ValidationError('INVALID_REFERENCE', 'floorIds must reference floors of this hotel')
    return hotelScoped.rooms.listByFloorIds(selector.floorIds)
  }

  if ('roomTypeIds' in selector) {
    const roomTypeIds = [...new Set(selector.roomTypeIds)]
    const roomTypes = await tenant.roomTypes.findByIds(roomTypeIds)
    if (roomTypes.length !== roomTypeIds.length) throw new ValidationError('INVALID_REFERENCE', 'roomTypeIds must reference room types of this organization')
    return hotelScoped.rooms.listByRoomTypeIds(selector.roomTypeIds)
  }

  const rows = await hotelScoped.rooms.findByIds(selector.roomIds)
  if (rows.length !== selector.roomIds.length) throw new ValidationError('INVALID_REFERENCE', 'roomIds must reference rooms of this hotel')
  return rows
}

// ---------------------------------------------------------------------------
// The shared apply/preview planning path (S6 — the single most important
// architectural point of this task). Both `applyOverrides` and
// `previewOverrides` call this SAME pure-read planning function: apply wraps
// it in a transaction and writes what it plans, preview calls it read-only.
// A preview followed by an apply of the same body therefore produces exactly
// the previewed rows.
// ---------------------------------------------------------------------------

export interface AppliedOverridePlan { roomId: string, roomNumber: string, before: CapacityValues, after: CapacityValues }
export type SkipReason = 'NOT_IN_INVENTORY_FOR_PERIOD' | 'ALREADY_OVERRIDDEN'
export interface SkippedOverridePlan { roomId: string, roomNumber: string, reason: SkipReason }
export interface OverridePlan { applied: AppliedOverridePlan[], skipped: SkippedOverridePlan[] }

/**
 * `options.lock` (apply ONLY — `hotelScoped` must then be bound to the apply transaction): the
 * resolved rooms are row-locked (`rooms.lockByIds`, ascending-id order) right after the selector is
 * resolved and BEFORE their base versions and existing overrides are read, so the coverage and
 * overlap checks below see the state committed by any concurrent retirement / override apply of
 * these rooms (those take the same room-row lock). The preview never passes it: it stays a
 * non-locking, side-effect-free read with exactly its previous queries.
 */
export async function planOverrideApplication(hotelScoped: ReturnType<typeof hotelRepos>, tenant: ReturnType<typeof tenantRepos>, period: CapacityPeriodRow, input: ApplyOverridesInput, today: IsoDate, options: { lock?: boolean } = {}): Promise<OverridePlan> {
  try {
    assertOverridesChangeable(period, today)
  }
  catch (error) {
    rethrowAsDomainError(error)
  }

  let rooms = await resolveSelectorRooms(hotelScoped, tenant, input.selector)
  if (rooms.length === 0) return { applied: [], skipped: [] }

  if (options.lock) {
    // Rooms are never deleted, so every resolved room comes back locked; the resolved ORDER is kept
    // (the plan — and so `skipped` — lists rooms exactly as the preview of the same body does).
    const lockedById = new Map((await hotelScoped.rooms.lockByIds(rooms.map(r => r.id))).map(r => [r.id, r]))
    rooms = rooms.flatMap((r) => {
      const locked = lockedById.get(r.id)
      return locked ? [locked] : []
    })
  }

  const roomIds = rooms.map(r => r.id)
  const periodRange = { from: period.startDate, to: period.endDate }
  const [versionRows, overlapping] = await Promise.all([
    hotelScoped.roomBaseConfigs.versionsForRooms(roomIds),
    hotelScoped.roomCapacityOverrides.findOverlapping(roomIds, periodRange),
  ])
  const versionsByRoom = groupByRoomId(versionRows)
  const overlappingRoomIds = new Set(overlapping.map(o => o.roomId))

  const applied: AppliedOverridePlan[] = []
  const skipped: SkippedOverridePlan[] = []

  for (const room of rooms) {
    const versions = (versionsByRoom.get(room.id) ?? []).map(toBaseVersion)

    // In inventory for EVERY night of the period (`coversEveryNight` — the same rule a period date
    // edit enforces on the candidate range).
    if (!coversEveryNight(versions, periodRange)) {
      skipped.push({ roomId: room.id, roomNumber: room.roomNumber, reason: 'NOT_IN_INVENTORY_FOR_PERIOD' })
      continue
    }

    if (overlappingRoomIds.has(room.id)) {
      skipped.push({ roomId: room.id, roomNumber: room.roomNumber, reason: 'ALREADY_OVERRIDDEN' })
      continue
    }

    // Coverage just proved a version covers the period's first night, so this is never null.
    const baseAtStart = baseCapacityAt(versions, period.startDate)!

    let after: CapacityValues
    try {
      after = computeOverrideValues(input.spec, baseAtStart)
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    applied.push({ roomId: room.id, roomNumber: room.roomNumber, before: baseAtStart, after })
  }

  return { applied, skipped }
}

/**
 * Applies overrides (`capacity.manage`) inside one transaction: plans via `planOverrideApplication`,
 * then (unless `onConflict: 'FAIL'` and something was skipped, which writes nothing and throws 409)
 * inserts every planned row and writes exactly one `CAPACITY_OVERRIDES_APPLIED` audit row. Lock
 * order, identical to `updateCapacityPeriod`: the period row first (serializes with a date edit or
 * another apply of the same period), then the planned rooms in ascending-id order before their
 * coverage is checked (serializes with a concurrent `retireRoom` of any of them, and with another
 * apply on the same rooms).
 */
export async function applyOverrides(ctx: AuthContext, hotelId: string, periodId: string, input: ApplyOverridesInput): Promise<{ applied: number, skipped: SkippedOverridePlan[] }> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    // Period row lock FIRST (same position as in updateCapacityPeriod): a concurrent date edit of this
    // period either committed before this read (and `period` carries its new dates) or waits for this
    // transaction — it can never cascade dates onto an override this apply has not validated.
    const period = await loadPeriodInScope(hotelScoped, periodId, { forUpdate: true })
    const today = todayInTimezone(hotel.timezone, ctx.now())

    // `lock: true` — the planned rooms are row-locked before their coverage is read (see planOverrideApplication).
    const plan = await planOverrideApplication(hotelScoped, tenant, period, input, today, { lock: true })

    if (input.onConflict === 'FAIL' && plan.skipped.length > 0) {
      throw new ConflictError('OVERRIDE_CONFLICT', 'One or more rooms could not receive this override', { skipped: plan.skipped })
    }

    if (plan.applied.length > 0) {
      try {
        await hotelScoped.roomCapacityOverrides.insertMany(plan.applied.map(a => ({
          roomId: a.roomId,
          periodId: period.id,
          validFrom: period.startDate,
          validTo: period.endDate,
          physicalBeds: a.after.physicalBeds,
          sellableCapacity: a.after.sellableCapacity,
          reason: input.reason ?? null,
          createdBy: ctx.identity.userId,
        })))
      }
      catch (error) {
        throw translateOverrideWriteError(error)
      }
    }

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'capacity_period',
      entityId: period.id,
      action: 'CAPACITY_OVERRIDES_APPLIED',
      before: null,
      after: { selector: input.selector, spec: input.spec, applied: plan.applied.length, skipped: plan.skipped.length },
      reason: input.reason,
    })

    return { applied: plan.applied.length, skipped: plan.skipped }
  })
}

export interface OverridePreviewTotals { rooms: number, bedsBefore: number, bedsAfter: number, sellableBefore: number, sellableAfter: number }
export interface OverrideHotelTotals { roomsInInventory: number, sellableBefore: number, sellableDuring: number }
export interface OverridePreview extends OverridePlan { totals: OverridePreviewTotals, hotelTotals: OverrideHotelTotals }

/**
 * Previews overrides (`capacity.manage` — a step of the write flow, not a read): calls the SAME
 * `planOverrideApplication` read-only, writes NOTHING, records NO audit row. `totals` summarize the
 * planned rooms; `hotelTotals` show the whole hotel's sellable capacity on the period's first night,
 * before and during the change.
 */
export async function previewOverrides(ctx: AuthContext, hotelId: string, periodId: string, input: ApplyOverridesInput): Promise<OverridePreview> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)
  const hotelScoped = hotelRepos(ctx.db, scope)
  const tenant = tenantRepos(ctx.db, ctx.scope)
  const period = await loadPeriodInScope(hotelScoped, periodId)
  const today = todayInTimezone(hotel.timezone, ctx.now())

  const plan = await planOverrideApplication(hotelScoped, tenant, period, input, today)

  const totals = plan.applied.reduce<OverridePreviewTotals>((acc, a) => ({
    rooms: acc.rooms + 1,
    bedsBefore: acc.bedsBefore + a.before.physicalBeds,
    bedsAfter: acc.bedsAfter + a.after.physicalBeds,
    sellableBefore: acc.sellableBefore + a.before.sellableCapacity,
    sellableAfter: acc.sellableAfter + a.after.sellableCapacity,
  }), { rooms: 0, bedsBefore: 0, bedsAfter: 0, sellableBefore: 0, sellableAfter: 0 })

  const roomIdsInInventory = await hotelScoped.rooms.idsInInventoryOn(period.startDate)
  const [hotelVersions, hotelOverrides] = await Promise.all([
    hotelScoped.roomBaseConfigs.versionsForRooms(roomIdsInInventory),
    hotelScoped.roomCapacityOverrides.findByRoomIds(roomIdsInInventory, { from: period.startDate, to: period.startDate }),
  ])
  const hotelVersionsByRoom = groupByRoomId(hotelVersions)
  const hotelOverridesByRoom = groupByRoomId(hotelOverrides)

  let sellableBefore = 0
  for (const roomId of roomIdsInInventory) {
    const versions = (hotelVersionsByRoom.get(roomId) ?? []).map(toBaseVersion)
    const overrides = (hotelOverridesByRoom.get(roomId) ?? []).map(toCapacityOverride)
    const eff = effectiveCapacityAt(versions, overrides, period.startDate)
    sellableBefore += eff?.sellableCapacity ?? 0
  }
  const sellableDuring = sellableBefore + (totals.sellableAfter - totals.sellableBefore)

  return { applied: plan.applied, skipped: plan.skipped, totals, hotelTotals: { roomsInInventory: roomIdsInInventory.length, sellableBefore, sellableDuring } }
}

// ---------------------------------------------------------------------------
// Single-override read/delete, bulk removal
// ---------------------------------------------------------------------------

export interface OverrideListItem { id: string, roomId: string, roomNumber: string, physicalBeds: number, sellableCapacity: number, reason: string | null, createdAt: string }

export async function listOverrides(ctx: AuthContext, hotelId: string, periodId: string): Promise<OverrideListItem[]> {
  const { scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const period = await loadPeriodInScope(hotelScoped, periodId)
  const overrides = await hotelScoped.roomCapacityOverrides.findByPeriod(period.id)
  if (overrides.length === 0) return []

  const rooms = await hotelScoped.rooms.findByIds(overrides.map(o => o.roomId))
  const roomById = new Map(rooms.map(r => [r.id, r]))
  return overrides.map(o => ({
    id: o.id,
    roomId: o.roomId,
    roomNumber: roomById.get(o.roomId)?.roomNumber ?? '',
    physicalBeds: o.physicalBeds,
    sellableCapacity: o.sellableCapacity,
    reason: o.reason,
    createdAt: o.createdAt.toISOString(),
  }))
}

/** Deletes one override (`capacity.manage`) — only while its period is FUTURE. */
export async function deleteOverride(ctx: AuthContext, hotelId: string, periodId: string, overrideId: string): Promise<{ id: string }> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const period = await loadPeriodInScope(hotelScoped, periodId)
    const today = todayInTimezone(hotel.timezone, ctx.now())

    const [existing] = await hotelScoped.roomCapacityOverrides.findByIdsInPeriod(period.id, [overrideId])
    if (!existing) throw new NotFoundError('OVERRIDE_NOT_FOUND')

    try {
      assertOverridesChangeable(period, today)
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    await hotelScoped.roomCapacityOverrides.deleteById(existing.id)

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'capacity_period',
      entityId: period.id,
      action: 'CAPACITY_OVERRIDE_DELETED',
      before: existing,
      after: null,
    })

    return { id: existing.id }
  })
}

/**
 * Bulk removal (S8, `capacity.manage`): 1..1,000 unique ids, ALL must belong to this period (else 422
 * `INVALID_REFERENCE`, nothing removed), only while FUTURE (else 409 `PERIOD_STARTED`), one
 * transaction, one `CAPACITY_OVERRIDES_REMOVED` audit row whose `before` is the removed rows.
 */
export async function removeOverrides(ctx: AuthContext, hotelId: string, periodId: string, input: RemoveOverridesInput): Promise<{ removed: number }> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const period = await loadPeriodInScope(hotelScoped, periodId)
    const today = todayInTimezone(hotel.timezone, ctx.now())

    const matched = await hotelScoped.roomCapacityOverrides.findByIdsInPeriod(period.id, input.overrideIds)
    if (matched.length !== input.overrideIds.length) {
      throw new ValidationError('INVALID_REFERENCE', 'overrideIds must all belong to this capacity period')
    }

    try {
      assertOverridesChangeable(period, today)
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    await hotelScoped.roomCapacityOverrides.deleteByIds(matched.map(m => m.id))

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'capacity_period',
      entityId: period.id,
      action: 'CAPACITY_OVERRIDES_REMOVED',
      before: matched,
      after: null,
    })

    return { removed: matched.length }
  })
}

// ---------------------------------------------------------------------------
// Historical preservation: a room's capacity timeline over an arbitrary
// range, resolved against the overrides that were actually in force —
// NEVER recomputed against today's state for a past range.
// ---------------------------------------------------------------------------

export interface CapacityTimelineResult {
  range: { from: IsoDate, to: IsoDate }
  meta: { today: IsoDate }
  segments: CapacitySegment[]
  refs: { periods: Record<string, PeriodRef> }
}

export async function getRoomCapacityTimeline(ctx: AuthContext, hotelId: string, roomId: string, query: CapacityTimelineQuery): Promise<CapacityTimelineResult> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const roomRow = await hotelScoped.rooms.findById(roomId)
  if (!roomRow) throw new NotFoundError('ROOM_NOT_FOUND')

  const range = { from: query.from, to: query.to }
  const [versionRows, overrideRows] = await Promise.all([
    hotelScoped.roomBaseConfigs.versionsForRoom(roomRow.id),
    hotelScoped.roomCapacityOverrides.findByRoomIds([roomRow.id], range),
  ])
  const segments = capacitySegments(versionRows.map(toBaseVersion), overrideRows.map(toCapacityOverride), range)

  // S13: refs hold EXACTLY the periods the returned segments reference — derived from the segments,
  // not from the override rows, since an override row on nights where the room is not in inventory
  // produces no segment (Task 9 rule 1: effective capacity is null there "even if an override row exists").
  const periodIds = [...new Set(segments.flatMap(s => (s.periodId ? [s.periodId] : [])))]
  const periods = periodIds.length === 0 ? [] : await hotelScoped.capacityPeriods.findByIds(periodIds)
  const refs: Record<string, PeriodRef> = {}
  for (const p of periods) refs[p.id] = { id: p.id, name: p.name, kind: p.kind as CapacityPeriodKind, startDate: p.startDate, endDate: p.endDate }

  return { range, meta: { today: todayInTimezone(hotel.timezone, ctx.now()) }, segments, refs: { periods: refs } }
}
