import type { CreateRoomTypeInput, ListRoomTypesQuery, UpdateRoomTypeInput } from '../../shared/schemas/roomType'
import { todayInTimezone } from '../../shared/utils/dates'
import { translateDbError } from '../errors/dbErrors'
import { ConflictError, NotFoundError } from '../errors/domainError'
import { tenantRepos } from '../repositories'
import type { RoomTypePatch, RoomTypeRow } from '../repositories/tenant'
import type { AuthContext } from '../security/authContext'
import { requireAllHotels, requireOrgPermission } from '../security/authorize'
import { recordAudit } from './audit'

/**
 * `usageCount` (Task 14): rooms in inventory across the ENTIRE organization for this room type, for
 * an `allHotels` caller only — `null` forever for a hotel-scoped (non-`allHotels`) caller, a
 * deliberate information-hiding rule (they must never learn organization-wide room usage of a
 * catalog entry they can otherwise see). Only `listRoomTypes` wires the real map (`usageCounts`
 * below); every other call site here (create/update/activate/deactivate) passes no map, which yields
 * `null` regardless of the caller's `allHotels` bit — mirroring `floorCount`/`roomCount`'s
 * "`undefined` map -> `null`" convention in `hotelService.ts`/`floorService.ts`.
 */
export interface RoomTypeListItem {
  id: string
  code: string
  name: string
  defaultPhysicalBeds: number
  defaultSellableCapacity: number
  description: string | null
  sortOrder: number
  isActive: boolean
  usageCount: number | null
}

function toRoomTypeListItem(row: RoomTypeRow, usageCounts?: ReadonlyMap<string, number>): RoomTypeListItem {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    defaultPhysicalBeds: row.defaultPhysicalBeds,
    defaultSellableCapacity: row.defaultSellableCapacity,
    description: row.description,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    usageCount: usageCounts ? (usageCounts.get(row.id) ?? 0) : null,
  }
}

/**
 * Reading the catalog is org-level and intentionally NOT gated by `allHotels` — a hotel-scoped user
 * with `room.view` may list room types; only `usageCount` itself is further gated by `allHotels`
 * (see the `RoomTypeListItem` docstring). `usageCounts` spans every hotel in the organization, each
 * potentially in a different timezone (fix round 1: a single shared reference date, e.g. UTC, is
 * WRONG for any hotel whose local date has already rolled over relative to another — this product's
 * real hotels are all `Asia/Riyadh`, so a UTC reference date would be a day behind for ~3 hours every
 * single day) — so each hotel's own local `today` (`todayInTimezone(hotel.timezone, ctx.now())`) is
 * computed here and passed into `RoomTypeRepository.usageCounts`, mirroring exactly how
 * `hotelService.ts`'s `computeRoomCounts` builds `HotelRepository.roomCounts`' per-hotel `asOf` list.
 */
async function computeUsageCounts(ctx: AuthContext): Promise<Map<string, number>> {
  const repos = tenantRepos(ctx.db, ctx.scope)
  const hotels = await repos.hotels.listAll()
  const hotelTodays = hotels.map(h => ({ hotelId: h.id, asOf: todayInTimezone(h.timezone, ctx.now()) }))
  return repos.roomTypes.usageCounts(hotelTodays)
}

export async function listRoomTypes(ctx: AuthContext, query: ListRoomTypesQuery): Promise<RoomTypeListItem[]> {
  requireOrgPermission(ctx, 'room.view')
  const rows = await tenantRepos(ctx.db, ctx.scope).roomTypes.list({ includeInactive: query.includeInactive })

  // ONE batched query for the whole list's usage counts (never one per room type or per hotel) —
  // skipped entirely for a non-allHotels caller, who must never learn this even indirectly via timing.
  const usageCounts = ctx.authz.allHotels ? await computeUsageCounts(ctx) : undefined

  return rows.map(row => toRoomTypeListItem(row, usageCounts))
}

export async function createRoomType(ctx: AuthContext, input: CreateRoomTypeInput): Promise<RoomTypeListItem> {
  // Writing room types is org-wide configuration: room.manage AND allHotels — a hotel-scoped manager
  // may not create/edit/(de)activate room types even with room.manage (mirrors createHotel's rule).
  requireOrgPermission(ctx, 'room.manage')
  requireAllHotels(ctx)

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)

    let created: RoomTypeRow
    try {
      created = await repos.roomTypes.insert(input)
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    // ROOM_TYPE_CREATED: hotel_id is ALWAYS null (organization-level configuration) — this is what
    // keeps room-type audit rows out of every hotel-scoped audit log (listHotelAudit filters strictly
    // on hotel_id = :hotelId).
    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: null,
      entityType: 'room_type',
      entityId: created.id,
      action: 'ROOM_TYPE_CREATED',
      before: null,
      after: created,
    })

    return toRoomTypeListItem(created)
  })
}

/** Only the fields the patch actually sets AND that differ from the current row — never the full row. */
function diffRoomTypeFields(row: RoomTypeRow, patch: UpdateRoomTypeInput): { before: Record<string, unknown>, after: Record<string, unknown>, changed: RoomTypePatch } {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const changed: Record<string, unknown> = {}

  for (const key of Object.keys(patch) as Array<keyof UpdateRoomTypeInput>) {
    const newValue = patch[key]
    if (newValue === undefined) continue
    const oldValue = (row as unknown as Record<string, unknown>)[key]
    if (oldValue !== newValue) {
      before[key] = oldValue
      after[key] = newValue
      changed[key] = newValue
    }
  }

  return { before, after, changed: changed as unknown as RoomTypePatch }
}

/**
 * `RoomTypeRepository.findById` is org-scoped (`OrgQuery`): a type id from another organization
 * cannot be found, and resolves to the identical 404 as a nonexistent id — never leaking existence.
 */
async function loadRoomTypeInScope(repos: ReturnType<typeof tenantRepos>, roomTypeId: string): Promise<RoomTypeRow> {
  const row = await repos.roomTypes.findById(roomTypeId)
  if (!row) throw new NotFoundError('ROOM_TYPE_NOT_FOUND')
  return row
}

export async function updateRoomType(ctx: AuthContext, roomTypeId: string, patch: UpdateRoomTypeInput): Promise<RoomTypeListItem> {
  requireOrgPermission(ctx, 'room.manage')
  requireAllHotels(ctx)

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const current = await loadRoomTypeInScope(repos, roomTypeId)

    const { before, after, changed } = diffRoomTypeFields(current, patch)

    // No-op patch: zero writes, zero audit rows, updated_at untouched — and (by construction, since
    // only the room_type row itself is ever touched here) no room is ever mutated by editing defaults.
    if (Object.keys(changed).length === 0) return toRoomTypeListItem(current)

    try {
      await repos.roomTypes.update(current.id, { ...changed, updatedAt: ctx.now() })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }
    const updated = await repos.roomTypes.findById(current.id)
    if (!updated) throw new ConflictError('ROOM_TYPE_NOT_FOUND', 'Room type no longer exists')

    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: null,
      entityType: 'room_type',
      entityId: current.id,
      action: 'ROOM_TYPE_UPDATED',
      before,
      after,
    })

    return toRoomTypeListItem(updated)
  })
}

export async function activateRoomType(ctx: AuthContext, roomTypeId: string): Promise<RoomTypeListItem> {
  requireOrgPermission(ctx, 'room.manage')
  requireAllHotels(ctx)

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const current = await loadRoomTypeInScope(repos, roomTypeId)
    if (current.isActive) throw new ConflictError('ROOM_TYPE_ALREADY_ACTIVE')

    await repos.roomTypes.setActive(current.id, true)
    const updated = await repos.roomTypes.findById(current.id)
    if (!updated) throw new ConflictError('ROOM_TYPE_NOT_FOUND', 'Room type no longer exists')

    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: null,
      entityType: 'room_type',
      entityId: current.id,
      action: 'ROOM_TYPE_UPDATED',
      before: { isActive: false },
      after: { isActive: true },
    })

    return toRoomTypeListItem(updated)
  })
}

export async function deactivateRoomType(ctx: AuthContext, roomTypeId: string): Promise<RoomTypeListItem> {
  requireOrgPermission(ctx, 'room.manage')
  requireAllHotels(ctx)

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const current = await loadRoomTypeInScope(repos, roomTypeId)
    if (!current.isActive) throw new ConflictError('ROOM_TYPE_ALREADY_INACTIVE')

    await repos.roomTypes.setActive(current.id, false)
    const updated = await repos.roomTypes.findById(current.id)
    if (!updated) throw new ConflictError('ROOM_TYPE_NOT_FOUND', 'Room type no longer exists')

    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: null,
      entityType: 'room_type',
      entityId: current.id,
      action: 'ROOM_TYPE_UPDATED',
      before: { isActive: true },
      after: { isActive: false },
    })

    return toRoomTypeListItem(updated)
  })
}
