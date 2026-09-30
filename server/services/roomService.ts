import type { BaseConfigOrigin } from '../../shared/constants/inventory'
import { MAX_BULK_ROOMS } from '../../shared/constants/inventory'
import type {
  BulkCreateRoomsInput,
  ChangeBaseConfigInput,
  CreateRoomInput,
  ListRoomsQuery,
  ReactivateRoomInput,
  RetireRoomInput,
  UpdateRoomInput,
} from '../../shared/schemas/room'
import { todayInTimezone } from '../../shared/utils/dates'
import { normalizeRoomNumber } from '../../shared/utils/roomNumber'
import { type BaseVersionRow, planBaseChange, planReactivate, planRetire } from '../domain/inventory/baseVersions'
import { InventoryRuleError } from '../domain/inventory/rules'
import { translateDbError } from '../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../errors/domainError'
import { hotelRepos, tenantRepos } from '../repositories'
import type { RoomBaseConfigRow, RoomPatch, RoomRow } from '../repositories/hotel'
import type { HotelRow, RoomTypeRow } from '../repositories/tenant'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel } from '../security/authorize'
import { recordAudit } from './audit'
import { type RoomDetail, type RoomListItem, toBaseVersion, toRoomDetail, toRoomListItem } from './roomDto'

export interface RoomListPage {
  items: RoomListItem[]
  page: number
  pageSize: number
  total: number
}

/** Rethrows a caught `InventoryRuleError` as the matching HTTP-mapped `DomainError`; anything else is rethrown unchanged. */
function rethrowAsDomainError(error: unknown): never {
  if (error instanceof InventoryRuleError) {
    throw error.kind === 'conflict' ? new ConflictError(error.code, error.message) : new ValidationError(error.code, error.message)
  }
  throw error
}

function toBaseVersionRow(row: RoomBaseConfigRow): BaseVersionRow {
  return { id: row.id, validFrom: row.validFrom, validTo: row.validTo, physicalBeds: row.physicalBeds, sellableCapacity: row.sellableCapacity }
}

/**
 * Looks the room up scoped to the ALREADY-authorized `HotelScope` (never a bare global-id lookup) —
 * a room belonging to another hotel of the same org, another org, or no room at all, are all
 * indistinguishable 404s here, exactly like `loadFloorInScope`/`loadRoomTypeInScope` in Task 12/13.
 */
async function loadRoomInScope(hotelScoped: ReturnType<typeof hotelRepos>, roomId: string): Promise<RoomRow> {
  const row = await hotelScoped.rooms.findById(roomId)
  if (!row) throw new NotFoundError('ROOM_NOT_FOUND')
  return row
}

/** An active floor of THIS hotel, or the generic body-reference 422 (never leaks whether a foreign floorId exists). */
async function loadActiveFloorRef(hotelScoped: ReturnType<typeof hotelRepos>, floorId: string) {
  const row = await hotelScoped.floors.findById(floorId)
  if (!row) throw new ValidationError('INVALID_REFERENCE', 'floorId does not reference a floor of this hotel')
  if (!row.isActive) throw new ConflictError('FLOOR_INACTIVE')
  return row
}

/** An active room type of THIS organization, or the generic body-reference 422. */
async function loadActiveRoomTypeRef(tenant: ReturnType<typeof tenantRepos>, roomTypeId: string): Promise<RoomTypeRow> {
  const row = await tenant.roomTypes.findById(roomTypeId)
  if (!row) throw new ValidationError('INVALID_REFERENCE', 'roomTypeId does not reference a room type of this organization')
  if (!row.isActive) throw new ConflictError('ROOM_TYPE_INACTIVE')
  return row
}

async function buildRoomDetail(ctx: AuthContext, hotel: HotelRow, hotelScoped: ReturnType<typeof hotelRepos>, tenant: ReturnType<typeof tenantRepos>, roomRow: RoomRow): Promise<RoomDetail> {
  const [floorRow, roomTypeRow, versionRows] = await Promise.all([
    hotelScoped.floors.findById(roomRow.floorId),
    tenant.roomTypes.findById(roomRow.roomTypeId),
    hotelScoped.roomBaseConfigs.versionsForRoom(roomRow.id),
  ])
  if (!floorRow || !roomTypeRow) throw new ConflictError('ROOM_NOT_FOUND', 'Room no longer exists')

  return toRoomDetail({
    room: roomRow,
    floor: floorRow,
    roomType: roomTypeRow,
    versions: versionRows.map(toBaseVersion),
    baseVersionRows: versionRows,
    asOf: todayInTimezone(hotel.timezone, ctx.now()),
  })
}

export async function getRoom(ctx: AuthContext, hotelId: string, roomId: string): Promise<RoomDetail> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const tenant = tenantRepos(ctx.db, ctx.scope)
  const roomRow = await loadRoomInScope(hotelScoped, roomId)
  return buildRoomDetail(ctx, hotel, hotelScoped, tenant, roomRow)
}

/**
 * Filtered, paginated room list. A FIXED number of statements regardless of page size: one for the
 * page of rooms (+ one for its total count), one batched `versionsForRooms` for every room on the
 * page, and one unfiltered `floors.list`/`roomTypes.list` each (small, whole-hotel/whole-org
 * lookups) — never one query per room.
 */
export async function listRooms(ctx: AuthContext, hotelId: string, query: ListRoomsQuery): Promise<RoomListPage> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const tenant = tenantRepos(ctx.db, ctx.scope)

  const asOf = query.asOf ?? todayInTimezone(hotel.timezone, ctx.now())

  const page = await hotelScoped.rooms.listPage({
    floorId: query.floorId,
    roomTypeId: query.roomTypeId,
    q: query.q,
    inventory: query.inventory ?? 'ALL',
    asOf,
    page: query.page,
    pageSize: query.pageSize,
  })

  if (page.rows.length === 0) return { items: [], page: query.page, pageSize: query.pageSize, total: page.total }

  const [versionRows, floorRows, roomTypeRows] = await Promise.all([
    hotelScoped.roomBaseConfigs.versionsForRooms(page.rows.map(r => r.id)),
    hotelScoped.floors.list({ includeInactive: true }),
    tenant.roomTypes.list({ includeInactive: true }),
  ])

  const versionsByRoom = new Map<string, RoomBaseConfigRow[]>()
  for (const v of versionRows) versionsByRoom.set(v.roomId, [...(versionsByRoom.get(v.roomId) ?? []), v])
  const floorById = new Map(floorRows.map(f => [f.id, f]))
  const roomTypeById = new Map(roomTypeRows.map(rt => [rt.id, rt]))

  const items = page.rows.map((roomRow) => {
    const floorRow = floorById.get(roomRow.floorId)
    const roomTypeRow = roomTypeById.get(roomRow.roomTypeId)
    if (!floorRow || !roomTypeRow) throw new ConflictError('ROOM_NOT_FOUND', 'Room no longer exists')
    const versions = (versionsByRoom.get(roomRow.id) ?? []).map(toBaseVersion)
    return toRoomListItem({ room: roomRow, floor: floorRow, roomType: roomTypeRow, versions, asOf })
  })

  return { items, page: query.page, pageSize: query.pageSize, total: page.total }
}

/**
 * Creates a room AND its first base-config version in ONE transaction. Capacity defaults to the room
 * type's CURRENT defaults at creation time (a snapshot — D1: editing the type's defaults later never
 * touches this room's history) when `physicalBeds`/`sellableCapacity` are omitted (`origin
 * ROOM_TYPE_DEFAULT`), or to the explicit values given (`origin MANUAL`).
 */
export async function createRoom(ctx: AuthContext, hotelId: string, input: CreateRoomInput): Promise<RoomDetail> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  const normalizedNumber = normalizeRoomNumber(input.roomNumber)
  if (!normalizedNumber) throw new ValidationError('INVALID_ROOM_NUMBER', 'Room number does not match the required format')

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)

    const floorRow = await loadActiveFloorRef(hotelScoped, input.floorId)
    const roomTypeRow = await loadActiveRoomTypeRef(tenant, input.roomTypeId)

    let createdRoom: RoomRow
    try {
      createdRoom = await hotelScoped.rooms.insert({
        floorId: floorRow.id,
        roomTypeId: roomTypeRow.id,
        roomNumber: normalizedNumber,
        features: input.features,
        notes: input.notes ?? null,
      })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    const explicit = input.physicalBeds !== undefined || input.sellableCapacity !== undefined
    const origin: BaseConfigOrigin = explicit ? 'MANUAL' : 'ROOM_TYPE_DEFAULT'
    const physicalBeds = input.physicalBeds ?? roomTypeRow.defaultPhysicalBeds
    const sellableCapacity = input.sellableCapacity ?? roomTypeRow.defaultSellableCapacity

    let baseVersion: RoomBaseConfigRow
    try {
      baseVersion = await hotelScoped.roomBaseConfigs.insert({
        roomId: createdRoom.id,
        validFrom: input.inServiceFrom,
        validTo: null,
        physicalBeds,
        sellableCapacity,
        origin,
        createdBy: ctx.identity.userId,
      })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    // ROOM_CREATED: room + its first base version + this audit row are all written in the SAME
    // transaction — a failure anywhere here (including the audit write itself) rolls everything
    // back, so no orphaned room row can ever exist without its base version.
    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'room',
      entityId: createdRoom.id,
      action: 'ROOM_CREATED',
      before: null,
      after: { ...createdRoom, baseVersion: { validFrom: baseVersion.validFrom, physicalBeds: baseVersion.physicalBeds, sellableCapacity: baseVersion.sellableCapacity, origin: baseVersion.origin } },
    })

    return toRoomDetail({
      room: createdRoom,
      floor: floorRow,
      roomType: roomTypeRow,
      versions: [toBaseVersion(baseVersion)],
      baseVersionRows: [baseVersion],
      asOf: todayInTimezone(hotel.timezone, ctx.now()),
    })
  })
}

/** Only the fields the patch actually sets AND that differ from the current row — never the full row. Handles `features` (an array) via a JSON-equality compare, not `!==`. */
function diffRoomFields(row: RoomRow, patch: Record<string, unknown>): { before: Record<string, unknown>, after: Record<string, unknown>, changed: RoomPatch } {
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  const changed: Record<string, unknown> = {}

  for (const [key, newValue] of Object.entries(patch)) {
    if (newValue === undefined) continue
    const oldValue = (row as unknown as Record<string, unknown>)[key]
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      before[key] = oldValue
      after[key] = newValue
      changed[key] = newValue
    }
  }

  return { before, after, changed: changed as unknown as RoomPatch }
}

/**
 * `floorId`/`roomTypeId`/`features`/`notes` only — `roomNumber` is immutable after creation (D16):
 * the schema allows it through as opaque text ONLY so this function can report the specific
 * `ROOM_NUMBER_IMMUTABLE` code (a `.strict()`-rejected key would report the generic
 * `VALIDATION_FAILED` instead, indistinguishable from every other unknown key). Changing
 * `roomTypeId` NEVER changes capacity — capacity only ever changes through `changeBaseConfig`.
 */
export async function updateRoom(ctx: AuthContext, hotelId: string, roomId: string, patch: UpdateRoomInput): Promise<RoomDetail> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  if (patch.roomNumber !== undefined) throw new ValidationError('ROOM_NUMBER_IMMUTABLE', 'Room number is immutable after creation')

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadRoomInScope(hotelScoped, roomId)

    if (patch.floorId !== undefined) await loadActiveFloorRef(hotelScoped, patch.floorId)
    if (patch.roomTypeId !== undefined) await loadActiveRoomTypeRef(tenant, patch.roomTypeId)

    const candidate: Record<string, unknown> = {}
    if (patch.floorId !== undefined) candidate.floorId = patch.floorId
    if (patch.roomTypeId !== undefined) candidate.roomTypeId = patch.roomTypeId
    if (patch.features !== undefined) candidate.features = patch.features
    if (patch.notes !== undefined) candidate.notes = patch.notes

    const { before, after, changed } = diffRoomFields(current, candidate)

    // No-op patch: zero writes, zero audit rows, updated_at untouched.
    if (Object.keys(changed).length === 0) return buildRoomDetail(ctx, hotel, hotelScoped, tenant, current)

    try {
      await hotelScoped.rooms.update(current.id, { ...changed, updatedAt: ctx.now() })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }
    const updated = await hotelScoped.rooms.findById(current.id)
    if (!updated) throw new ConflictError('ROOM_NOT_FOUND', 'Room no longer exists')

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'room',
      entityId: current.id,
      action: 'ROOM_UPDATED',
      before,
      after,
    })

    return buildRoomDetail(ctx, hotel, hotelScoped, tenant, updated)
  })
}

/**
 * A permanent base-capacity change (`capacity.manage`): closes the currently-open version the day
 * before `effectiveFrom` and opens a new one, in the SAME transaction as its `ROOM_BASE_CHANGED`
 * audit row. History is never rewritten — the closed version's `validFrom`/`physicalBeds`/
 * `sellableCapacity`/`origin` are untouched, only its `validTo` is set once.
 */
export async function changeBaseConfig(ctx: AuthContext, hotelId: string, roomId: string, input: ChangeBaseConfigInput): Promise<RoomDetail> {
  const { hotel, scope } = await authorizeHotel(ctx, 'capacity.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadRoomInScope(hotelScoped, roomId)
    const versionRows = await hotelScoped.roomBaseConfigs.versionsForRoom(current.id)
    const today = todayInTimezone(hotel.timezone, ctx.now())

    let plan: ReturnType<typeof planBaseChange>
    try {
      plan = planBaseChange(versionRows.map(toBaseVersionRow), input.effectiveFrom, today, { physicalBeds: input.physicalBeds, sellableCapacity: input.sellableCapacity })
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    const closedVersion = versionRows.find(v => v.id === plan.close.id)!

    let inserted: RoomBaseConfigRow
    try {
      await hotelScoped.roomBaseConfigs.closeVersion(plan.close.id, plan.close.validTo)
      inserted = await hotelScoped.roomBaseConfigs.insert({
        roomId: current.id,
        validFrom: plan.insert.validFrom,
        validTo: plan.insert.validTo,
        physicalBeds: plan.insert.physicalBeds,
        sellableCapacity: plan.insert.sellableCapacity,
        origin: 'MANUAL',
        reason: input.reason ?? null,
        createdBy: ctx.identity.userId,
      })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'room',
      entityId: current.id,
      action: 'ROOM_BASE_CHANGED',
      before: { validTo: closedVersion.validTo, physicalBeds: closedVersion.physicalBeds, sellableCapacity: closedVersion.sellableCapacity },
      after: { validFrom: inserted.validFrom, physicalBeds: inserted.physicalBeds, sellableCapacity: inserted.sellableCapacity },
      reason: input.reason,
    })

    return buildRoomDetail(ctx, hotel, hotelScoped, tenant, current)
  })
}

/**
 * Retires a room (`room.manage`): closes the open version. Guards for Task 15's overrides and
 * Task 16's blocks extending past the retirement date are intentionally NOT implemented here — each
 * of those tasks adds its own guard, with its own test, when it lands.
 */
export async function retireRoom(ctx: AuthContext, hotelId: string, roomId: string, input: RetireRoomInput): Promise<RoomDetail> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadRoomInScope(hotelScoped, roomId)
    const versionRows = await hotelScoped.roomBaseConfigs.versionsForRoom(current.id)
    const today = todayInTimezone(hotel.timezone, ctx.now())

    let plan: ReturnType<typeof planRetire>
    try {
      plan = planRetire(versionRows.map(toBaseVersionRow), input.effectiveFrom, today)
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    const closedVersion = versionRows.find(v => v.id === plan.close.id)!

    try {
      await hotelScoped.roomBaseConfigs.closeVersion(plan.close.id, plan.close.validTo)
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'room',
      entityId: current.id,
      action: 'ROOM_RETIRED',
      before: { validTo: closedVersion.validTo },
      after: { validTo: plan.close.validTo },
      reason: input.reason,
    })

    return buildRoomDetail(ctx, hotel, hotelScoped, tenant, current)
  })
}

/** Reactivates a retired room (`room.manage`): opens a new open-ended version after the last one (a gap is legitimate). */
export async function reactivateRoom(ctx: AuthContext, hotelId: string, roomId: string, input: ReactivateRoomInput): Promise<RoomDetail> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadRoomInScope(hotelScoped, roomId)
    const versionRows = await hotelScoped.roomBaseConfigs.versionsForRoom(current.id)
    const today = todayInTimezone(hotel.timezone, ctx.now())

    let plan: ReturnType<typeof planReactivate>
    try {
      plan = planReactivate(versionRows.map(toBaseVersionRow), input.effectiveFrom, today, { physicalBeds: input.physicalBeds, sellableCapacity: input.sellableCapacity })
    }
    catch (error) {
      rethrowAsDomainError(error)
    }

    let inserted: RoomBaseConfigRow
    try {
      inserted = await hotelScoped.roomBaseConfigs.insert({
        roomId: current.id,
        validFrom: plan.insert.validFrom,
        validTo: plan.insert.validTo,
        physicalBeds: plan.insert.physicalBeds,
        sellableCapacity: plan.insert.sellableCapacity,
        origin: 'MANUAL',
        reason: input.reason ?? null,
        createdBy: ctx.identity.userId,
      })
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'room',
      entityId: current.id,
      action: 'ROOM_REACTIVATED',
      before: null,
      after: { validFrom: inserted.validFrom, physicalBeds: inserted.physicalBeds, sellableCapacity: inserted.sellableCapacity },
      reason: input.reason,
    })

    return buildRoomDetail(ctx, hotel, hotelScoped, tenant, current)
  })
}

function generateRangeNumbers(range: { prefix?: string, from: number, to: number, pad?: number }): string[] {
  const out: string[] = []
  for (let n = range.from; n <= range.to; n++) {
    const digits = range.pad ? String(n).padStart(range.pad, '0') : String(n)
    out.push(`${range.prefix ?? ''}${digits}`)
  }
  return out
}

/**
 * Bulk room create (`room.manage`), ALL-OR-NOTHING in one transaction: normalizes every requested
 * number BEFORE duplicate/conflict detection, rejects duplicates within the request, rejects any
 * number that already exists in this hotel's lifetime history (`details.conflicts`), then inserts
 * every room row + its initial base version + one `ROOM_CREATED` audit row per room, all in the SAME
 * transaction.
 */
export async function bulkCreateRooms(ctx: AuthContext, hotelId: string, input: BulkCreateRoomsInput): Promise<RoomListItem[]> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.manage', hotelId)

  const rawNumbers = input.numbers ?? generateRangeNumbers(input.range!)
  if (rawNumbers.length > MAX_BULK_ROOMS) {
    throw new ValidationError('TOO_MANY_ROOMS', `A bulk request must not create more than ${MAX_BULK_ROOMS} rooms`)
  }

  const normalized: string[] = []
  for (const raw of rawNumbers) {
    const n = normalizeRoomNumber(raw)
    if (!n) throw new ValidationError('INVALID_ROOM_NUMBER', `"${raw}" is not a valid room number`)
    normalized.push(n)
  }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const n of normalized) {
    if (seen.has(n)) duplicates.add(n)
    seen.add(n)
  }
  if (duplicates.size > 0) {
    throw new ValidationError('DUPLICATE_ROOM_NUMBER', 'Duplicate room numbers within the request', { duplicates: [...duplicates] })
  }

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)

    const floorRow = await loadActiveFloorRef(hotelScoped, input.floorId)
    const roomTypeRow = await loadActiveRoomTypeRef(tenant, input.roomTypeId)

    // Lifetime-uniqueness pre-check: a retired room's number still counts (no soft-delete, no status
    // column — every row in `room` counts forever). Re-checked structurally by the DB's unique
    // constraint too, but checking here first lets the whole request fail with a friendly
    // `details.conflicts` list instead of a raw constraint-violation race.
    const existing = await hotelScoped.rooms.findByNumbers(normalized)
    if (existing.length > 0) {
      throw new ConflictError('ROOM_NUMBER_CONFLICT', 'One or more room numbers already exist in this hotel', { conflicts: existing.map(r => r.roomNumber) })
    }

    const explicit = input.physicalBeds !== undefined || input.sellableCapacity !== undefined
    const origin: BaseConfigOrigin = explicit ? 'MANUAL' : 'BULK'
    const physicalBeds = input.physicalBeds ?? roomTypeRow.defaultPhysicalBeds
    const sellableCapacity = input.sellableCapacity ?? roomTypeRow.defaultSellableCapacity

    let createdRooms: RoomRow[]
    try {
      createdRooms = await hotelScoped.rooms.insertMany(normalized.map(roomNumber => ({
        floorId: floorRow.id,
        roomTypeId: roomTypeRow.id,
        roomNumber,
        features: [],
        notes: null,
      })))
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    let baseVersions: RoomBaseConfigRow[]
    try {
      baseVersions = await hotelScoped.roomBaseConfigs.insertMany(createdRooms.map(r => ({
        roomId: r.id,
        validFrom: input.inServiceFrom,
        validTo: null,
        physicalBeds,
        sellableCapacity,
        origin,
        createdBy: ctx.identity.userId,
      })))
    }
    catch (error) {
      const translated = translateDbError(error)
      throw translated ?? error
    }

    // One ROOM_CREATED audit row per room, all inserts + all audit rows in the SAME transaction —
    // an audit-write failure partway through rolls back every insert already made (atomicity).
    for (const r of createdRooms) {
      await recordAudit(tenant.audit, ctx.identity.userId, {
        hotelId: hotel.id,
        entityType: 'room',
        entityId: r.id,
        action: 'ROOM_CREATED',
        before: null,
        after: r,
      })
    }

    const asOf = todayInTimezone(hotel.timezone, ctx.now())
    const versionsByRoom = new Map(baseVersions.map(v => [v.roomId, [toBaseVersion(v)]]))
    return createdRooms.map(r => toRoomListItem({ room: r, floor: floorRow, roomType: roomTypeRow, versions: versionsByRoom.get(r.id) ?? [], asOf }))
  })
}
