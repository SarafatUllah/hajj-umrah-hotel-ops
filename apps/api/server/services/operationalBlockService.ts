import { type BlockKind, MAX_BULK_ROOMS } from '../../shared/constants/inventory'
import type { BulkCreateRoomBlocksInput, CancelRoomBlockInput, CreateRoomBlockInput, ListRoomBlocksQuery } from '../../shared/schemas/roomBlock'
import { InvalidRangeError, type IsoDate, type NightRange, rangeLength, todayInTimezone } from '../../shared/utils/dates'
import { assertBlockCreatable, planBlockCancellation } from '../domain/inventory/blockRules'
import { capacitySegments } from '../domain/inventory/capacity'
import { InventoryRuleError } from '../domain/inventory/rules'
import { extractPgError, translateDbError } from '../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../errors/domainError'
import { hotelRepos, tenantRepos } from '../repositories'
import type { RoomBaseConfigRow, RoomOperationalBlockRow, RoomOperationalBlockView, RoomRow } from '../repositories/hotel'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel } from '../security/authorize'
import { recordAudit } from './audit'
import { type BlockListItem, toBlockListItem } from './blockDto'
import { toBaseVersion } from './roomDto'

type HotelScoped = ReturnType<typeof hotelRepos>

/**
 * Operational blocks (D3): a room unavailable for a dated, reasoned cause. Every write follows the
 * reference pattern — `authorizeHotel` FIRST, then ONE transaction holding the repository write(s) and
 * their audit row(s) together, so an audit failure rolls the block back. "Today" is always the
 * hotel's own (`todayInTimezone(hotel.timezone, ctx.now())`). Blocks are never deleted.
 *
 * Phase 2 seam (documented, not built): creating a block over nights that hold a booking/hold will be
 * rejected HERE, next to the BLOCK_OVERLAP pre-check; the block tables need no change for it.
 */

export interface BlockListPage {
  items: BlockListItem[]
  page: number
  pageSize: number
  total: number
}

/** Rethrows a domain rule error as its HTTP-mapped `DomainError`. `InvalidRangeError` (from `makeRange` when `endDate < startDate` reaches the service directly) is a 422 too. */
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
 * Translates the database error of a block insert. Besides the registry-driven `translateDbError`
 * (23P01 `room_block_no_overlap` -> 409 RANGE_OVERLAP, checks -> 422, FK -> 422), a deadlock (40P01)
 * is the same exclusion race resolved by PostgreSQL itself: two transactions inserting conflicting
 * same-kind blocks for one room at the same instant each wait on the other's in-progress row in the
 * GiST exclusion check, and PostgreSQL aborts one with 40P01 instead of 23P01 (the geometry Task 15
 * reproduced for `room_override_no_overlap`). The aborted transaction wrote nothing — it is the race's
 * loser and gets the same 409 a 23P01 loser gets, never an untranslated 500.
 */
function translateBlockWriteError(error: unknown): unknown {
  if (extractPgError(error)?.code === '40P01') {
    return new ConflictError('RANGE_OVERLAP', 'A concurrent change gave this room a block of the same kind on the same nights; nothing was saved')
  }
  return translateDbError(error) ?? error
}

/** The block/cancel reason cap — the same limit the zod schema enforces (`safeText(500)` in `shared/schemas/roomBlock.ts`). */
const MAX_REASON_LENGTH = 500

/**
 * Defensive service-level check (service callers bypass the zod schema): a reason is required, must
 * be non-blank after trimming, and at most `MAX_REASON_LENGTH` characters after trimming (the schema
 * measures the trimmed value too).
 */
function requireReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim()
  if (trimmed.length === 0) throw new ValidationError('REASON_REQUIRED', 'A reason is required')
  if (trimmed.length > MAX_REASON_LENGTH) throw new ValidationError('REASON_TOO_LONG', `A reason must be at most ${MAX_REASON_LENGTH} characters`)
  return trimmed
}

function assertCreatable(startDate: IsoDate, endDate: IsoDate, today: IsoDate): NightRange {
  try {
    assertBlockCreatable(startDate, endDate, today)
  }
  catch (error) {
    rethrowAsDomainError(error)
  }
  return { from: startDate, to: endDate }
}

function groupByRoomId<T extends { roomId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const r of rows) map.set(r.roomId, [...(map.get(r.roomId) ?? []), r])
  return map
}

/** Nights of `range` on which the room is in inventory (a base version covers them) — the SAME coverage machinery Task 15 uses for overrides (`capacitySegments` with no overrides). */
function nightsInInventory(versionRows: readonly RoomBaseConfigRow[], range: NightRange): number {
  return capacitySegments(versionRows.map(toBaseVersion), [], range).reduce((n, s) => n + rangeLength(s), 0)
}

async function loadRoomInScope(hotelScoped: HotelScoped, roomId: string, options: { forUpdate?: boolean } = {}): Promise<RoomRow> {
  const row = await hotelScoped.rooms.findById(roomId, options)
  if (!row) throw new NotFoundError('ROOM_NOT_FOUND')
  return row
}

async function loadBlockInScope(hotelScoped: HotelScoped, blockId: string, options: { forUpdate?: boolean } = {}): Promise<RoomOperationalBlockRow> {
  const row = await hotelScoped.operationalBlocks.findById(blockId, options)
  if (!row) throw new NotFoundError('BLOCK_NOT_FOUND')
  return row
}

/** Re-reads the written blocks as DTO views (room number + same-organization actor names) — one query. */
async function viewsOf(hotelScoped: HotelScoped, rows: readonly RoomOperationalBlockRow[]): Promise<RoomOperationalBlockView[]> {
  const views = await hotelScoped.operationalBlocks.findViewsByIds(rows.map(r => r.id))
  const byId = new Map(views.map(v => [v.block.id, v]))
  return rows.map((r) => {
    const view = byId.get(r.id)
    if (!view) throw new ConflictError('BLOCK_NOT_FOUND', 'Block no longer exists')
    return view
  })
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** `room.view`. One query for the page, one for the total — never one per block (actor names and room numbers are joined). */
export async function listRoomBlocks(ctx: AuthContext, hotelId: string, query: ListRoomBlocksQuery): Promise<BlockListPage> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  const hotelScoped = hotelRepos(ctx.db, scope)
  const today = todayInTimezone(hotel.timezone, ctx.now())

  const page = await hotelScoped.operationalBlocks.list({
    from: query.from,
    to: query.to,
    roomId: query.roomId,
    kind: query.kind,
    includeCancelled: query.includeCancelled,
    page: query.page,
    pageSize: query.pageSize,
  })

  return { items: page.rows.map(v => toBlockListItem(v, today)), page: query.page, pageSize: query.pageSize, total: page.total }
}

// ---------------------------------------------------------------------------
// Create (one room)
// ---------------------------------------------------------------------------

/**
 * `room.block`: one block on one room. Rules, in order: a non-blank reason; `assertBlockCreatable`
 * (starts today or later in hotel time, at most 731 nights, end not before start); the room belongs
 * to this hotel (else 404); the room is in inventory for EVERY night (else 422
 * `ROOM_NOT_IN_INVENTORY_FOR_BLOCK`); no active block of the SAME kind shares a night (409
 * `BLOCK_OVERLAP`, with `room_block_no_overlap` as the database backstop for races).
 *
 * The room row is locked (`FOR UPDATE`) FIRST, before the coverage and overlap checks: retirement
 * (and every other block/override writer of this room) takes the same lock, so a concurrent
 * retirement either commits before this transaction reads the room's versions (and the coverage
 * check then sees the closed version -> 422) or waits until this block is committed (and its own
 * guard then sees it -> 409 `ROOM_HAS_ACTIVE_BLOCKS`).
 */
export async function createRoomBlock(ctx: AuthContext, hotelId: string, roomId: string, input: CreateRoomBlockInput): Promise<BlockListItem> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.block', hotelId)
  const reason = requireReason(input.reason)
  const today = todayInTimezone(hotel.timezone, ctx.now())
  const range = assertCreatable(input.startDate, input.endDate, today)
  const kind: BlockKind = input.kind

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const roomRow = await loadRoomInScope(hotelScoped, roomId, { forUpdate: true })

    const versionRows = await hotelScoped.roomBaseConfigs.versionsForRoom(roomRow.id)
    if (nightsInInventory(versionRows, range) !== rangeLength(range)) {
      throw new ValidationError('ROOM_NOT_IN_INVENTORY_FOR_BLOCK', `Room ${roomRow.roomNumber} is not in inventory for every night of this block`)
    }

    // Friendly pre-check. Concurrent creates on this room are serialized by the room lock above; the
    // exclusion constraint stays the database backstop for any writer that does not take it.
    // (Phase 2: the booking/hold conflict check joins here.)
    const overlapping = await hotelScoped.operationalBlocks.findActiveOverlapping([roomRow.id], range, [kind])
    if (overlapping.length > 0) {
      throw new ConflictError('BLOCK_OVERLAP', `Room ${roomRow.roomNumber} already has an active block of this kind on one or more of these nights`)
    }

    let created: RoomOperationalBlockRow
    try {
      created = await hotelScoped.operationalBlocks.insert({ roomId: roomRow.id, kind, startDate: range.from, endDate: range.to, reason, createdBy: ctx.identity.userId })
    }
    catch (error) {
      throw translateBlockWriteError(error)
    }

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'room_block',
      entityId: created.id,
      action: 'BLOCK_CREATED',
      before: null,
      after: created,
      reason,
    })

    const [view] = await viewsOf(hotelScoped, [created])
    return toBlockListItem(view!, today)
  })
}

// ---------------------------------------------------------------------------
// Bulk create
// ---------------------------------------------------------------------------

export interface BlockConflict { roomId: string, roomNumber: string, reason: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK' | 'BLOCK_OVERLAP' }

/**
 * Resolves the selector inside this hotel and ROW-LOCKS the candidate rooms (`rooms.lockByIds`: one
 * statement, ascending-id lock order) BEFORE any inventory coverage is read — every base-version read
 * below happens under the locks, so a concurrent retirement of one of these rooms has either fully
 * committed (and is seen) or waits for this transaction. `roomIds`: every id must be a room of this
 * hotel (else 422 `INVALID_REFERENCE`, nothing written; the locked read itself is the hotel-scoped
 * lookup, so a foreign id is neither returned nor locked) — each is then checked for inventory
 * coverage. `floorId`: the floor must belong to this hotel (else 422 `INVALID_REFERENCE`); its rooms
 * are locked, and those (still on this floor once locked) that are in inventory on at least one night
 * of the block are selected (a room retired long ago or not yet commissioned is simply not a
 * candidate), and any of those that are NOT in inventory for every night is a conflict.
 */
async function resolveAndLockBulkRooms(hotelScoped: HotelScoped, input: BulkCreateRoomBlocksInput, range: NightRange): Promise<{ rooms: RoomRow[], versionsByRoom: Map<string, RoomBaseConfigRow[]> }> {
  if ('roomIds' in input) {
    const roomIds = [...new Set(input.roomIds)] // the schema already dedupes; direct service callers may not
    const rows = await hotelScoped.rooms.lockByIds(roomIds)
    if (rows.length !== roomIds.length) throw new ValidationError('INVALID_REFERENCE', 'roomIds must reference rooms of this hotel')
    const versionsByRoom = groupByRoomId(await hotelScoped.roomBaseConfigs.versionsForRooms(rows.map(r => r.id)))
    return { rooms: rows, versionsByRoom }
  }

  const floorRow = await hotelScoped.floors.findById(input.floorId)
  if (!floorRow) throw new ValidationError('INVALID_REFERENCE', 'floorId does not reference a floor of this hotel')
  const onFloor = await hotelScoped.rooms.listAllOnFloor(floorRow.id)
  // The locked rows are the committed ones: a room moved off this floor before we got its lock is dropped.
  const locked = (await hotelScoped.rooms.lockByIds(onFloor.map(r => r.id))).filter(r => r.floorId === floorRow.id)
  const versionsByRoom = groupByRoomId(await hotelScoped.roomBaseConfigs.versionsForRooms(locked.map(r => r.id)))
  const rooms = locked.filter(r => nightsInInventory(versionsByRoom.get(r.id) ?? [], range) > 0)
  return { rooms, versionsByRoom }
}

function byRoomNumber(a: { roomNumber: string }, b: { roomNumber: string }): number {
  return a.roomNumber.length - b.roomNumber.length || (a.roomNumber < b.roomNumber ? -1 : a.roomNumber > b.roomNumber ? 1 : 0)
}

/**
 * `room.block`, ALL-OR-NOTHING in one transaction: at most `MAX_BULK_ROOMS` rooms (422
 * `TOO_MANY_ROOMS`); any room not in inventory for every night or with a same-kind overlap makes the
 * whole request a 409 `BLOCK_CONFLICT` with `details.conflicts: [{ roomId, roomNumber, reason }]` and
 * writes nothing; otherwise one INSERT for every block, one `BLOCK_CREATED` audit row per block plus
 * one `BLOCKS_BULK_CREATED` summary row — all in the same transaction.
 */
export async function bulkCreateRoomBlocks(ctx: AuthContext, hotelId: string, input: BulkCreateRoomBlocksInput): Promise<BlockListItem[]> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.block', hotelId)
  const reason = requireReason(input.reason)
  const today = todayInTimezone(hotel.timezone, ctx.now())
  const range = assertCreatable(input.startDate, input.endDate, today)
  const kind: BlockKind = input.kind
  if ('roomIds' in input && new Set(input.roomIds).size > MAX_BULK_ROOMS) {
    throw new ValidationError('TOO_MANY_ROOMS', `A bulk block must not cover more than ${MAX_BULK_ROOMS} rooms`)
  }

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)

    // Locks every candidate room FIRST; the coverage and overlap checks below all run under those locks.
    const { rooms, versionsByRoom } = await resolveAndLockBulkRooms(hotelScoped, input, range)
    if (rooms.length > MAX_BULK_ROOMS) throw new ValidationError('TOO_MANY_ROOMS', `A bulk block must not cover more than ${MAX_BULK_ROOMS} rooms`)
    if (rooms.length === 0) throw new ValidationError('NO_ROOMS_TO_BLOCK', 'No room of this selection is in inventory on these nights')

    const conflicts: BlockConflict[] = []
    const notCovered = new Set<string>()
    for (const r of rooms) {
      if (nightsInInventory(versionsByRoom.get(r.id) ?? [], range) !== rangeLength(range)) {
        notCovered.add(r.id)
        conflicts.push({ roomId: r.id, roomNumber: r.roomNumber, reason: 'ROOM_NOT_IN_INVENTORY_FOR_BLOCK' })
      }
    }
    // (Phase 2: the booking/hold conflict check joins here.)
    const overlapping = new Set((await hotelScoped.operationalBlocks.findActiveOverlapping(rooms.map(r => r.id), range, [kind])).map(b => b.roomId))
    for (const r of rooms) {
      if (overlapping.has(r.id) && !notCovered.has(r.id)) conflicts.push({ roomId: r.id, roomNumber: r.roomNumber, reason: 'BLOCK_OVERLAP' })
    }
    if (conflicts.length > 0) {
      throw new ConflictError('BLOCK_CONFLICT', 'One or more rooms cannot receive this block; nothing was saved', { conflicts: conflicts.sort(byRoomNumber) })
    }

    let created: RoomOperationalBlockRow[]
    try {
      created = await hotelScoped.operationalBlocks.insertMany(rooms.map(r => ({ roomId: r.id, kind, startDate: range.from, endDate: range.to, reason, createdBy: ctx.identity.userId })))
    }
    catch (error) {
      throw translateBlockWriteError(error)
    }

    for (const row of created) {
      await recordAudit(tenant.audit, ctx.identity.userId, {
        hotelId: hotel.id,
        entityType: 'room_block',
        entityId: row.id,
        action: 'BLOCK_CREATED',
        before: null,
        after: row,
        reason,
      })
    }
    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'hotel',
      entityId: hotel.id,
      action: 'BLOCKS_BULK_CREATED',
      before: null,
      after: {
        kind,
        startDate: range.from,
        endDate: range.to,
        selector: 'roomIds' in input ? { roomIds: input.roomIds } : { floorId: input.floorId },
        blockIds: created.map(r => r.id),
        count: created.length,
      },
      reason,
    })

    const views = await viewsOf(hotelScoped, created)
    return views.map(v => toBlockListItem(v, today)).sort((a, b) => byRoomNumber(a.room, b.room))
  })
}

// ---------------------------------------------------------------------------
// Cancel / end early
// ---------------------------------------------------------------------------

/**
 * `room.block`, reason required. `planBlockCancellation` with the hotel's today decides: an unstarted
 * block (start >= today) is soft-cancelled (`BLOCK_CANCELLED`); a running one is ENDED YESTERDAY in
 * one UPDATE that also records `original_end_date`/`ended_early_at`/`ended_early_by` and the reason
 * (S11), so the nights already blocked stay blocked in the history (`BLOCK_ENDED_EARLY`); a finished
 * or already-cancelled block -> 409. The block row is read `FOR UPDATE`, so two concurrent cancels of
 * the same block serialize and the second sees the first's result (409). Never deletes.
 */
export async function cancelRoomBlock(ctx: AuthContext, hotelId: string, blockId: string, input: CancelRoomBlockInput): Promise<BlockListItem> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.block', hotelId)
  const reason = requireReason(input.reason)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current = await loadBlockInScope(hotelScoped, blockId, { forUpdate: true })
    const today = todayInTimezone(hotel.timezone, ctx.now())

    let plan: ReturnType<typeof planBlockCancellation>
    try {
      plan = planBlockCancellation(current, today)
    }
    catch (error) {
      rethrowAsDomainError(error)
    }
    // An ended-early block always ends before today, so the rule above already answered 409 for it;
    // this keeps the guarantee explicit should that ever change.
    if (current.endedEarlyAt) throw new ConflictError('BLOCK_ALREADY_ENDED', 'This block has already ended')

    const at = ctx.now()
    const updated = plan.kind === 'CANCEL'
      ? await hotelScoped.operationalBlocks.markCancelled(current.id, at, ctx.identity.userId, reason)
      : await hotelScoped.operationalBlocks.endEarly(current.id, { newEndDate: plan.newEndDate, at, by: ctx.identity.userId, reason })
    if (!updated) throw new ConflictError('BLOCK_ALREADY_CANCELLED', 'This block was changed concurrently; nothing was saved')

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'room_block',
      entityId: current.id,
      action: plan.kind === 'CANCEL' ? 'BLOCK_CANCELLED' : 'BLOCK_ENDED_EARLY',
      before: plan.kind === 'CANCEL' ? { cancelledAt: null } : { endDate: current.endDate },
      after: plan.kind === 'CANCEL'
        ? { cancelledAt: updated.cancelledAt }
        : { endDate: updated.endDate, originalEndDate: updated.originalEndDate, endedEarlyAt: updated.endedEarlyAt },
      reason,
    })

    const [view] = await viewsOf(hotelScoped, [updated])
    return toBlockListItem(view!, today)
  })
}
