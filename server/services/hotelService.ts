import { resolveSettings, type ResolvedSettings, type UpdateSettingsInput } from '../../shared/business-rules/hotelSettings'
import { encodeAuditCursor, type CreateHotelInput, type ListHotelAuditQuery, type UpdateHotelInput } from '../../shared/schemas/hotel'
import { todayInTimezone } from '../../shared/utils/dates'
import { orgCan, hasHotelAccess } from '../domain/rbac/authorize'
import { translateDbError } from '../errors/dbErrors'
import { ConflictError } from '../errors/domainError'
import { hotelRepos, tenantRepos } from '../repositories'
import type { HotelPatch, HotelRow } from '../repositories/tenant'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel, requireAllHotels, requireOrgPermission } from '../security/authorize'
import { recordAudit } from './audit'
import { toHotelDetail, toHotelSummary, type HotelDetail, type HotelDtoExtras, type HotelSummary } from './hotelDto'

/**
 * `today` is always computed from the hotel's own timezone and the injected clock — never the
 * server/browser's local date.
 *
 * `floorCount` (PF-13, Task 13): the number of ACTIVE floors, only populated when the caller has
 * `room.view` — otherwise `null`. `floorCounts` is a precomputed map (built by the caller via ONE
 * batched `HotelRepository.activeFloorCounts` call for the whole result set — see `computeFloorCounts`
 * below) so this function itself never issues a query; `undefined` means "not computed for this call
 * site" (createHotel/updateHotel/activateHotel/deactivateHotel, which are out of Task 13's wiring
 * scope — only `GET /api/hotels` and `GET /api/hotels/:hotelId` wire real counts) and always yields
 * `null`, regardless of `room.view`.
 *
 * `roomCount` stays `null` until Task 14.
 */
function hotelExtras(ctx: AuthContext, hotel: HotelRow, floorCounts?: ReadonlyMap<string, number>): HotelDtoExtras {
  const canViewRooms = orgCan(ctx.authz, 'room.view')
  const floorCount = canViewRooms && floorCounts ? (floorCounts.get(hotel.id) ?? 0) : null
  const roomCount = null
  return { today: todayInTimezone(hotel.timezone, ctx.now()), floorCount, roomCount }
}

/**
 * Builds the batched floor-count map for `hotelIds` in ONE query (`HotelRepository.activeFloorCounts`)
 * — skipped entirely (no query at all) when the caller lacks `room.view` or the id list is empty.
 */
async function computeFloorCounts(ctx: AuthContext, hotelIds: readonly string[]): Promise<ReadonlyMap<string, number> | undefined> {
  if (!orgCan(ctx.authz, 'room.view') || hotelIds.length === 0) return undefined
  return tenantRepos(ctx.db, ctx.scope).hotels.activeFloorCounts(hotelIds)
}

function byName(a: HotelSummary, b: HotelSummary): number {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

export async function listHotels(ctx: AuthContext): Promise<HotelSummary[]> {
  requireOrgPermission(ctx, 'hotel.view')

  const all = await tenantRepos(ctx.db, ctx.scope).hotels.listAll()
  const accessible = all.filter(hotel => hasHotelAccess(ctx.authz, hotel.id))

  // ONE batched query for the whole list's floor counts (never one per hotel) — see computeFloorCounts.
  const floorCounts = await computeFloorCounts(ctx, accessible.map(hotel => hotel.id))

  return accessible
    .map(hotel => toHotelSummary(hotel, hotelExtras(ctx, hotel, floorCounts)))
    .sort(byName)
}

export async function getHotel(ctx: AuthContext, hotelId: string): Promise<HotelDetail> {
  const { hotel } = await authorizeHotel(ctx, 'hotel.view', hotelId, { allowInactive: true })
  const floorCounts = await computeFloorCounts(ctx, [hotel.id])
  return toHotelDetail(hotel, hotelExtras(ctx, hotel, floorCounts))
}

export async function createHotel(ctx: AuthContext, input: CreateHotelInput): Promise<HotelDetail> {
  // Rule: creating a hotel needs BOTH hotel.manage AND allHotels — a hotel-scoped manager may not
  // create hotels even with hotel.manage.
  requireOrgPermission(ctx, 'hotel.manage')
  requireAllHotels(ctx)

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)

    let created: HotelRow
    try {
      created = await repos.hotels.insert(input)
    }
    catch (error) {
      // Translated here (not only at the API layer) so a duplicate code surfaces as the same
      // ConflictError('ALREADY_EXISTS') whether createHotel is called directly (integration tests) or
      // through the route (defineApiHandler's own translateDbError fallback never even runs).
      const translated = translateDbError(error)
      throw translated ?? error
    }

    // HOTEL_CREATED: before is null, after is the created row's fields. Written in the same
    // transaction as the insert — a failure here rolls the insert back too (atomicity).
    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: created.id,
      entityType: 'hotel',
      entityId: created.id,
      action: 'HOTEL_CREATED',
      before: null,
      after: created,
    })

    return toHotelDetail(created, hotelExtras(ctx, created))
  })
}

/** Only the fields patch actually sets AND that differ from the current row — never the full row. */
function diffHotelFields(hotel: HotelRow, patch: UpdateHotelInput): { before: Record<string, unknown>, after: Record<string, unknown>, changed: HotelPatch } {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const changed: Record<string, unknown> = {}

  for (const key of Object.keys(patch) as Array<keyof UpdateHotelInput>) {
    const newValue = patch[key]
    if (newValue === undefined) continue
    const oldValue = (hotel as unknown as Record<string, unknown>)[key]
    if (oldValue !== newValue) {
      before[key] = oldValue
      after[key] = newValue
      changed[key] = newValue
    }
  }

  return { before, after, changed: changed as unknown as HotelPatch }
}

export async function updateHotel(ctx: AuthContext, hotelId: string, patch: UpdateHotelInput): Promise<HotelDetail> {
  const { hotel } = await authorizeHotel(ctx, 'hotel.manage', hotelId, { allowInactive: true })

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    const { before, after, changed } = diffHotelFields(hotel, patch)

    // No-op patch: zero writes, zero audit rows, updated_at untouched.
    if (Object.keys(changed).length === 0) return toHotelDetail(hotel, hotelExtras(ctx, hotel))

    await repos.hotels.update(hotel.id, { ...changed, updatedAt: ctx.now() })
    const updated = await repos.hotels.findById(hotel.id)
    if (!updated) throw new ConflictError('HOTEL_NOT_FOUND', 'Hotel no longer exists')

    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'hotel',
      entityId: hotel.id,
      action: 'HOTEL_UPDATED',
      before,
      after,
    })

    return toHotelDetail(updated, hotelExtras(ctx, updated))
  })
}

export async function activateHotel(ctx: AuthContext, hotelId: string): Promise<HotelDetail> {
  const { hotel } = await authorizeHotel(ctx, 'hotel.manage', hotelId, { allowInactive: true })
  if (hotel.status === 'ACTIVE') throw new ConflictError('ALREADY_ACTIVE')

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    await repos.hotels.setStatus(hotel.id, 'ACTIVE')
    const updated = await repos.hotels.findById(hotel.id)
    if (!updated) throw new ConflictError('HOTEL_NOT_FOUND', 'Hotel no longer exists')

    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'hotel',
      entityId: hotel.id,
      action: 'HOTEL_ACTIVATED',
      before: { status: 'INACTIVE' },
      after: { status: 'ACTIVE' },
    })

    return toHotelDetail(updated, hotelExtras(ctx, updated))
  })
}

export async function deactivateHotel(ctx: AuthContext, hotelId: string): Promise<HotelDetail> {
  const { hotel } = await authorizeHotel(ctx, 'hotel.manage', hotelId, { allowInactive: true })
  if (hotel.status === 'INACTIVE') throw new ConflictError('ALREADY_INACTIVE')

  return ctx.db.transaction(async (tx) => {
    const repos = tenantRepos(tx, ctx.scope)
    await repos.hotels.setStatus(hotel.id, 'INACTIVE')
    const updated = await repos.hotels.findById(hotel.id)
    if (!updated) throw new ConflictError('HOTEL_NOT_FOUND', 'Hotel no longer exists')

    await recordAudit(repos.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'hotel',
      entityId: hotel.id,
      action: 'HOTEL_DEACTIVATED',
      before: { status: 'ACTIVE' },
      after: { status: 'INACTIVE' },
    })

    return toHotelDetail(updated, hotelExtras(ctx, updated))
  })
}

async function currentSettings(repos: ReturnType<typeof hotelRepos>): Promise<{ stored: Record<string, unknown>, resolved: ResolvedSettings }> {
  const rows = await repos.settings.getAll()
  const stored: Record<string, unknown> = {}
  for (const row of rows) stored[row.key] = row.value
  return { stored, resolved: resolveSettings(stored) }
}

export async function getSettings(ctx: AuthContext, hotelId: string): Promise<ResolvedSettings> {
  const { scope } = await authorizeHotel(ctx, 'hotel.view', hotelId, { allowInactive: true })
  const { resolved } = await currentSettings(hotelRepos(ctx.db, scope))
  return resolved
}

export async function updateSettings(ctx: AuthContext, hotelId: string, patch: UpdateSettingsInput): Promise<ResolvedSettings> {
  const { hotel, scope } = await authorizeHotel(ctx, 'hotel.manage', hotelId, { allowInactive: true })

  return ctx.db.transaction(async (tx) => {
    const tenant = tenantRepos(tx, ctx.scope)
    const hotelScoped = hotelRepos(tx, scope)
    const { stored, resolved: current } = await currentSettings(hotelScoped)

    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const key of Object.keys(patch) as Array<keyof UpdateSettingsInput>) {
      const newValue = patch[key]
      if (newValue === undefined) continue
      const oldValue = current[key]
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        before[key] = oldValue
        after[key] = newValue
      }
    }

    // No-op patch: zero writes, zero audit rows.
    if (Object.keys(after).length === 0) return current

    for (const [key, value] of Object.entries(after)) {
      await hotelScoped.settings.upsert(key, value)
    }

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'hotel',
      entityId: hotel.id,
      action: 'HOTEL_SETTINGS_CHANGED',
      before,
      after,
    })

    return resolveSettings({ ...stored, ...after })
  })
}

export interface AuditItemDto {
  id: string
  action: string
  entityType: string
  entityId: string
  actor: { id: string, fullName: string } | null
  before: unknown
  after: unknown
  reason: string | null
  createdAt: string
}

export interface AuditPageDto {
  items: AuditItemDto[]
  nextCursor: string | null
}

export async function listHotelAudit(ctx: AuthContext, hotelId: string, filter: ListHotelAuditQuery): Promise<AuditPageDto> {
  const { scope } = await authorizeHotel(ctx, 'audit.view', hotelId, { allowInactive: true })
  const page = await tenantRepos(ctx.db, scope).audit.listForHotel(hotelId, filter)

  return {
    items: page.rows.map(row => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actor: row.actor,
      before: row.beforeData,
      after: row.afterData,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor ? encodeAuditCursor(page.nextCursor) : null,
  }
}
