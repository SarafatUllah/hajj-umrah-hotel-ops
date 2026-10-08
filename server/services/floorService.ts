import type { BulkCreateFloorsInput, CreateFloorInput, ListFloorsQuery, UpdateFloorInput } from '../../shared/schemas/floor'
import { type IsoDate, toEpochDay, todayInTimezone } from '../../shared/utils/dates'
import { translateDbError } from '../errors/dbErrors'
import { ConflictError, NotFoundError } from '../errors/domainError'
import { hotelRepos, tenantRepos } from '../repositories'
import type { FloorPatch, FloorRow } from '../repositories/hotel'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel } from '../security/authorize'
import { recordAudit } from './audit'

/** `0` = Ground Floor; every other level's default label is `"Floor N"`. Applied by the service — never the schema — so it stays in exactly one place. */
function defaultFloorLabel(level: number): string {
  return level === 0 ? 'Ground' : `Floor ${level}`
}

export interface FloorListItem {
  id: string
  level: number
  label: string
  isActive: boolean
  /** Rooms in inventory (a base-config version covering the hotel's own local today) on this floor. */
  roomCount: number
}

function toFloorListItem(row: FloorRow, roomCount: number): FloorListItem {
  return { id: row.id, level: row.level, label: row.label, isActive: row.isActive, roomCount }
}

export async function listFloors(ctx: AuthContext, hotelId: string, query: ListFloorsQuery): Promise<FloorListItem[]> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const rows = await hotelScoped.floors.list({ includeInactive: query.includeInactive })

  // ONE batched query for the whole list's room counts (never one per floor) — mirrors PF-13's
  // activeFloorCounts pattern for HotelSummary/HotelDetail.
  const today = todayInTimezone(hotel.timezone, ctx.now())
  const roomCounts = await hotelScoped.rooms.countInInventoryByFloor(today)

  return rows.map(row => toFloorListItem(row, roomCounts.get(row.id) ?? 0))
}

export async function createFloor(ctx: AuthContext, hotelId: string, input: CreateFloorInput): Promise<FloorListItem> {
  // Writes reject an inactive hotel (no allowInactive) — the opposite of Task 12's hotel PATCH/activate/deactivate.
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)
  const label = input.label ?? defaultFloorLabel(input.level)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)

    let created: FloorRow
    try {
      created = await hotelScoped.floors.insert({ level: input.level, label })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    // FLOOR_CREATED: before is null, after is the created row's fields — written in the same
    // transaction as the insert, so a failure here rolls the insert back too (atomicity).
    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'floor',
      entityId: created.id,
      action: 'FLOOR_CREATED',
      before: null,
      after: created,
    })

    // A brand-new floor structurally has zero rooms yet — no query needed.
    return toFloorListItem(created, 0)
  })
}

export async function bulkCreateFloors(ctx: AuthContext, hotelId: string, input: BulkCreateFloorsInput): Promise<FloorListItem[]> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  const levels: number[] = []
  for (let level = input.fromLevel; level <= input.toLevel; level++) levels.push(level)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)

    // One query for every existing floor in this hotel (not one per requested level), so the
    // all-or-nothing conflict check and the eventual insert both read from a single consistent
    // snapshot taken inside this transaction.
    const existingLevels = new Set((await hotelScoped.floors.list({ includeInactive: true })).map(f => f.level))
    const conflicts = levels.filter(l => existingLevels.has(l))
    if (conflicts.length > 0) {
      throw new ConflictError('ALREADY_EXISTS', 'One or more requested floor levels already exist in this hotel', { existing: conflicts })
    }

    const created = await hotelScoped.floors.insertMany(levels.map(level => ({ level, label: defaultFloorLabel(level) })))

    // Every created floor gets its own FLOOR_CREATED audit row, all inserts + all audit rows in the
    // SAME transaction — if any audit write throws, the whole transaction (every insert included)
    // rolls back (atomicity; see the atomicity test spying AuditRepository.record).
    for (const row of created) {
      await recordAudit(tenant.audit, ctx.identity.userId, {
        hotelId: hotel.id,
        entityType: 'floor',
        entityId: row.id,
        action: 'FLOOR_CREATED',
        before: null,
        after: row,
      })
    }

    // Every bulk-created floor structurally has zero rooms yet — no query needed.
    return created.map(row => toFloorListItem(row, 0))
  })
}

/** Only the fields the patch actually sets AND that differ from the current row — never the full row. */
function diffFloorFields(row: FloorRow, patch: UpdateFloorInput): { before: Record<string, unknown>, after: Record<string, unknown>, changed: FloorPatch } {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const changed: Record<string, unknown> = {}

  for (const key of Object.keys(patch) as Array<keyof UpdateFloorInput>) {
    const newValue = patch[key]
    if (newValue === undefined) continue
    const oldValue = (row as unknown as Record<string, unknown>)[key]
    if (oldValue !== newValue) {
      before[key] = oldValue
      after[key] = newValue
      changed[key] = newValue
    }
  }

  return { before, after, changed: changed as unknown as FloorPatch }
}

/**
 * Looks the floor up scoped to the ALREADY-authorized `HotelScope` (never a bare global-id lookup) —
 * a floor belonging to another hotel of the same org, another org, or no floor at all, are all
 * indistinguishable 404s here, because `FloorRepository.findById` structurally cannot see rows
 * outside `scope.organizationId` AND `scope.hotelId`.
 */
async function loadFloorInScope(repos: ReturnType<typeof hotelRepos>, floorId: string): Promise<FloorRow> {
  const row = await repos.floors.findById(floorId)
  if (!row) throw new NotFoundError('FLOOR_NOT_FOUND')
  return row
}

/**
 * Task 14 floor-deactivation guard: a floor cannot be deactivated while ANY room on it has its
 * LATEST base-config version open-ended (`validTo IS NULL`) OR ending on/after `today` — regardless
 * of when that latest version actually STARTS (a not-yet-commissioned room with a future,
 * open-ended first version still blocks deactivation). Once every room on the floor has been retired
 * with a last night strictly BEFORE `today`, the floor may deactivate. Two queries total (never one
 * per room): all rooms on the floor, then all of their base-config versions in one batched call.
 */
async function assertFloorHasNoRoomsInInventory(repos: ReturnType<typeof hotelRepos>, floorId: string, today: IsoDate): Promise<void> {
  const roomsOnFloor = await repos.rooms.listAllOnFloor(floorId)
  if (roomsOnFloor.length === 0) return

  const versions = await repos.roomBaseConfigs.versionsForRooms(roomsOnFloor.map(r => r.id))
  const todayEpoch = toEpochDay(today)

  for (const room of roomsOnFloor) {
    const roomVersions = versions.filter(v => v.roomId === room.id)
    if (roomVersions.length === 0) continue
    const latest = roomVersions.reduce((a, b) => (toEpochDay(a.validFrom) > toEpochDay(b.validFrom) ? a : b))
    if (latest.validTo === null || toEpochDay(latest.validTo) >= todayEpoch) {
      throw new ConflictError('FLOOR_HAS_ROOMS', 'This floor has rooms in inventory today or scheduled to remain so; retire them first')
    }
  }
}

export async function updateFloor(ctx: AuthContext, hotelId: string, floorId: string, patch: UpdateFloorInput): Promise<FloorListItem> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadFloorInScope(hotelScoped, floorId)

    const { before, after, changed } = diffFloorFields(current, patch)
    const today = todayInTimezone(hotel.timezone, ctx.now())

    // No-op patch: zero writes, zero audit rows, updated_at untouched.
    if (Object.keys(changed).length === 0) return toFloorListItem(current, await hotelScoped.rooms.countInInventoryOnFloor(current.id, today))

    try {
      await hotelScoped.floors.update(current.id, { ...changed, updatedAt: ctx.now() })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }
    const updated = await hotelScoped.floors.findById(current.id)
    if (!updated) throw new ConflictError('FLOOR_NOT_FOUND', 'Floor no longer exists')

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'floor',
      entityId: current.id,
      action: 'FLOOR_UPDATED',
      before,
      after,
    })

    return toFloorListItem(updated, await hotelScoped.rooms.countInInventoryOnFloor(updated.id, today))
  })
}

export async function activateFloor(ctx: AuthContext, hotelId: string, floorId: string): Promise<FloorListItem> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadFloorInScope(hotelScoped, floorId)
    if (current.isActive) throw new ConflictError('FLOOR_ALREADY_ACTIVE')

    await hotelScoped.floors.setActive(current.id, true)
    const updated = await hotelScoped.floors.findById(current.id)
    if (!updated) throw new ConflictError('FLOOR_NOT_FOUND', 'Floor no longer exists')

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'floor',
      entityId: current.id,
      action: 'FLOOR_UPDATED',
      before: { isActive: false },
      after: { isActive: true },
    })

    const today = todayInTimezone(hotel.timezone, ctx.now())
    return toFloorListItem(updated, await hotelScoped.rooms.countInInventoryOnFloor(updated.id, today))
  })
}

export async function deactivateFloor(ctx: AuthContext, hotelId: string, floorId: string): Promise<FloorListItem> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadFloorInScope(hotelScoped, floorId)
    if (!current.isActive) throw new ConflictError('FLOOR_ALREADY_INACTIVE')

    const today = todayInTimezone(hotel.timezone, ctx.now())
    await assertFloorHasNoRoomsInInventory(hotelScoped, current.id, today)

    await hotelScoped.floors.setActive(current.id, false)
    const updated = await hotelScoped.floors.findById(current.id)
    if (!updated) throw new ConflictError('FLOOR_NOT_FOUND', 'Floor no longer exists')

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'floor',
      entityId: current.id,
      action: 'FLOOR_UPDATED',
      before: { isActive: true },
      after: { isActive: false },
    })

    return toFloorListItem(updated, await hotelScoped.rooms.countInInventoryOnFloor(updated.id, today))
  })
}
