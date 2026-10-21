import { resolveSettings } from '../../shared/business-rules/hotelSettings'
import { type BlockKind, CALENDAR_FILTER_STATUSES, type CalendarFilterStatus, type CapacityPeriodKind, DEFAULT_CALENDAR_PAGE_SIZE, MAX_CALENDAR_RESPONSE_BYTES, MAX_CALENDAR_ROOMS, MAX_ROOMS_PER_PAGE } from '../../shared/constants/inventory'
import { calendarQueryIssues } from '../../shared/schemas/roomCalendar'
import { type IsoDate, type NightRange, isValidIsoDate, todayInTimezone } from '../../shared/utils/dates'
import { buildRoomSegments, type CalendarOptions, type CalendarSegment, type DailySummary, matchesCapacityFilter, matchesStatusFilter, summarizeDaily } from '../domain/inventory/calendar'
import { ValidationError } from '../errors/domainError'
import { hotelRepos } from '../repositories'
import type { InventoryReadRepository, InventoryRefs, InventoryRoomInput, RoomCandidate, RoomCandidateFilter } from '../repositories/hotel'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel } from '../security/authorize'
import type { HotelScope } from '../security/scope'

/** `today` is the hotel-local today (`todayInTimezone(hotel.timezone, ctx.now())`); `maintenanceBlocksSales` is the resolved hotel setting. */
export interface CalendarMetaDto {
  today: IsoDate
  maintenanceBlocksSales: boolean
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
}

export interface RoomCalendarDto {
  range: NightRange
  page: number
  pageSize: number
  /** Rooms matching every filter (before paging) — exact. */
  total: number
  meta: CalendarMetaDto
  /** EXACTLY the periods and blocks referenced by the segments of `rooms` (this page) — nothing else. */
  refs: CalendarRefsDto
  rooms: CalendarRoomDto[]
}

export interface DailySummaryDto {
  range: NightRange
  meta: CalendarMetaDto
  /** One row per date of the inclusive range, in date order. */
  days: DailySummary[]
}

export interface RoomCalendarQueryInput {
  from: IsoDate
  to: IsoDate
  floorId?: string
  roomTypeId?: string
  q?: string
  minCapacity?: number
  maxCapacity?: number
  status?: CalendarFilterStatus[]
  statusMatch?: 'any' | 'all'
  includeOutOfInventory?: boolean
  page?: number
  pageSize?: number
}

export interface DailySummaryInput {
  from: IsoDate
  to: IsoDate
  floorId?: string
  roomTypeId?: string
}

/** Defensive re-check for direct callers (the HTTP boundary already rejected these via the zod schemas). */
function assertValidInput(q: RoomCalendarQueryInput | DailySummaryInput): void {
  for (const value of [q.from, q.to]) {
    if (!isValidIsoDate(value)) throw new ValidationError('INVALID_DATE', 'Dates must be valid YYYY-MM-DD dates')
  }
  const [issue] = calendarQueryIssues(q)
  if (issue) throw new ValidationError(issue.code, issue.message, { path: issue.path })
}

function assertValidCalendarInput(q: RoomCalendarQueryInput): void {
  assertValidInput(q)
  const intIn = (v: number | undefined, min: number, max: number) => v === undefined || (Number.isInteger(v) && v >= min && v <= max)
  if (!intIn(q.page, 1, Number.MAX_SAFE_INTEGER) || !intIn(q.pageSize, 1, MAX_ROOMS_PER_PAGE)) throw new ValidationError('INVALID_PAGE', `page must be >= 1 and pageSize between 1 and ${MAX_ROOMS_PER_PAGE}`)
  if (!intIn(q.minCapacity, 0, Number.MAX_SAFE_INTEGER) || !intIn(q.maxCapacity, 0, Number.MAX_SAFE_INTEGER)) throw new ValidationError('INVALID_CAPACITY_RANGE', 'Capacity bounds must be non-negative integers')
  if (q.status?.some(s => !(CALENDAR_FILTER_STATUSES as readonly string[]).includes(s))) throw new ValidationError('INVALID_STATUS', `status must be one of ${CALENDAR_FILTER_STATUSES.join(', ')}`)
}

/** The hotel's calendar options from `hotel_setting` (stored rows + registry defaults) — ONE statement, the same mechanism as Task 17's. */
async function calendarOptions(ctx: AuthContext, scope: HotelScope): Promise<CalendarOptions> {
  const rows = await hotelRepos(ctx.db, scope).settings.getAll()
  const stored: Record<string, unknown> = {}
  for (const row of rows) stored[row.key] = row.value
  return { maintenanceBlocksSales: resolveSettings(stored)['inventory.maintenanceBlocksSales'] }
}

interface Derived {
  candidates: Map<string, RoomCandidate>
  rooms: InventoryRoomInput[]
  refs: InventoryRefs
  options: CalendarOptions
}

const tooManyRooms = () => new ValidationError('TOO_MANY_ROOMS', `More than ${MAX_CALENDAR_ROOMS} rooms match; narrow the request with floorId, roomTypeId or q`, { limit: MAX_CALENDAR_ROOMS })

/**
 * The candidates of a request whose structural filters match MORE than `MAX_CALENDAR_ROOMS` rooms and
 * that excludes out-of-inventory rooms: only rooms with a base version overlapping `range` count, so the
 * request is still valid when at most `MAX_CALENDAR_ROOMS` of them do. Decided WITHOUT joining
 * `room_base_config` to `room` (every join/EXISTS/IN form of it was measured choosing a quadratic
 * nested loop on tables without statistics: 0.66 s to 165 s) — only single-table, index-friendly
 * statements, each bounded by `MAX_CALENDAR_ROOMS + 1`:
 *  1. the hotel's in-inventory room ids, `LIMIT MAX + 1`. At most MAX of them: every relevant room is among
 *     them, so the structural query restricted to those ids returns exactly the relevant rooms.
 *  2. More than MAX and no structural filter: the relevant rooms ARE those, so more than MAX -> 422.
 *  3. More than MAX and a structural filter (rare: the filter still leaves > MAX rooms in a hotel with > MAX
 *     in inventory): page through the structural candidates MAX at a time, keep those with a version in the
 *     range, stop with a 422 as soon as more than MAX are kept.
 */
async function relevantCandidates(inventory: InventoryReadRepository, range: NightRange, structural: RoomCandidateFilter): Promise<RoomCandidate[]> {
  const ids = await inventory.listRoomIdsInInventory(range, { limit: MAX_CALENDAR_ROOMS + 1 })
  if (ids.length <= MAX_CALENDAR_ROOMS) return inventory.listRoomCandidates({ ...structural, roomIds: ids })
  if (structural.floorId === undefined && structural.roomTypeId === undefined && !structural.q) throw tooManyRooms()

  const relevant: RoomCandidate[] = []
  for (let offset = 0; ; offset += MAX_CALENDAR_ROOMS) {
    const page = await inventory.listRoomCandidates({ ...structural, limit: MAX_CALENDAR_ROOMS, offset })
    const inInventory = new Set(await inventory.listRoomIdsInInventory(range, { roomIds: page.map(r => r.id) }))
    for (const r of page) if (inInventory.has(r.id)) relevant.push(r)
    if (relevant.length > MAX_CALENDAR_ROOMS) throw tooManyRooms()
    if (page.length < MAX_CALENDAR_ROOMS) return relevant
  }
}

/**
 * Steps 2–3 of both endpoints. FIRST the candidate rooms — structural filters, joined to floor and
 * room type — read with `LIMIT MAX_CALENDAR_ROOMS + 1`: the statement never reads more than 5,001 rows.
 * At most `MAX_CALENDAR_ROOMS` rows: they are the candidates (unless `includeOutOfInventory`, rooms
 * without a version in the range are dropped by the inventory load below), and the request continues
 * in a FIXED number of statements: the settings read together with one inventory load of three
 * statements (the rooms' rows are already loaded, so no rooms statement) — 6 with the hotel read of
 * `authorizeHotel`, whatever the room or night count. 5,001 rows: with `includeOutOfInventory` every
 * structural candidate counts, so that is already the 422 `TOO_MANY_ROOMS` (never a truncated answer;
 * paging happens later and cannot get around it) after 2 statements — before any settings, version,
 * override or block read; without it only rooms in inventory in the range count (`relevantCandidates`).
 */
async function derive(ctx: AuthContext, scope: HotelScope, range: NightRange, filter: { floorId?: string, roomTypeId?: string, q?: string, includeOutOfInventory: boolean, withRefs: boolean }): Promise<Derived> {
  const inventory = hotelRepos(ctx.db, scope).inventoryRead
  const structural = { floorId: filter.floorId, roomTypeId: filter.roomTypeId, q: filter.q }
  let candidateRows = await inventory.listRoomCandidates({ ...structural, limit: MAX_CALENDAR_ROOMS + 1 })
  if (candidateRows.length > MAX_CALENDAR_ROOMS) {
    if (filter.includeOutOfInventory) throw tooManyRooms()
    candidateRows = await relevantCandidates(inventory, range, structural)
  }
  const candidates = new Map(candidateRows.map(c => [c.id, c]))
  if (candidateRows.length === 0) return { candidates, rooms: [], refs: { periods: new Map(), blocks: new Map() }, options: await calendarOptions(ctx, scope) }

  // A structural filter narrows the range statements to the candidates in SQL; without one the
  // candidates ARE the hotel's rooms (or, without `includeOutOfInventory`, the rooms with a version in
  // the range, whose statements' rows of other rooms are dropped in memory), and the hotel predicate
  // alone selects them.
  const filtered = filter.floorId !== undefined || filter.roomTypeId !== undefined || (filter.q !== undefined && filter.q !== '')
  const load = {
    rooms: candidateRows,
    roomIds: filtered ? candidateRows.map(c => c.id) : undefined,
    includeBlocks: true,
    includeOutOfInventory: filter.includeOutOfInventory,
  }
  const [options, loaded] = await Promise.all([
    calendarOptions(ctx, scope),
    filter.withRefs
      ? inventory.loadRoomInputs(range, { ...load, withRefs: true })
      : inventory.loadRoomInputs(range, load).then(rooms => ({ rooms, refs: { periods: new Map(), blocks: new Map() } as InventoryRefs })),
  ])
  return { candidates, rooms: loaded.rooms, refs: loaded.refs, options }
}

/** The exact size, in bytes, of the JSON body the API sends for `dto` (h3 serializes the returned object with `JSON.stringify`). */
export function calendarResponseBytes(dto: RoomCalendarDto): number {
  return Buffer.byteLength(JSON.stringify(dto))
}

/**
 * The response-size guarantee: a calendar body above `limit` bytes (default `MAX_CALENDAR_RESPONSE_BYTES`,
 * 2 MiB) is a 422 `CALENDAR_RESPONSE_TOO_LARGE` — explicit, never a truncated page. A body of exactly
 * `limit` bytes is served. The check is on the real serialized body because the size depends on the
 * data (a 200-room x 400-night page measured 2.37 MB at the scale hotel's density, and a room with a
 * block every other night is several times denser), which no `pageSize` x days product can bound
 * without also rejecting ordinary pages.
 */
export function assertCalendarResponseWithinBudget(dto: RoomCalendarDto, limit: number = MAX_CALENDAR_RESPONSE_BYTES): void {
  const bytes = calendarResponseBytes(dto)
  if (bytes > limit) {
    throw new ValidationError('CALENDAR_RESPONSE_TOO_LARGE', `This page would be ${bytes} bytes, above the ${limit}-byte response limit; request fewer rooms (pageSize) or a shorter date range`, { limitBytes: limit, bytes, pageSize: dto.pageSize, rooms: dto.rooms.length })
  }
}

/**
 * The date-wise room calendar (`room.view`; inactive hotels are readable): rows = rooms, columns =
 * the nights of `from…to`, served as run-length segments DERIVED from base versions, seasonal
 * overrides and active blocks — no room x day row exists anywhere. Derived filters (status,
 * capacity) apply to the full candidate set before paging, so `total` is exact; `refs` carry exactly
 * the periods and blocks the returned page's segments reference. The body never exceeds
 * `MAX_CALENDAR_RESPONSE_BYTES` (2 MiB): a larger page is a 422 `CALENDAR_RESPONSE_TOO_LARGE`.
 */
export async function getRoomCalendar(ctx: AuthContext, hotelId: string, q: RoomCalendarQueryInput): Promise<RoomCalendarDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  assertValidCalendarInput(q)

  const range: NightRange = { from: q.from, to: q.to }
  const page = q.page ?? 1
  const pageSize = q.pageSize ?? DEFAULT_CALENDAR_PAGE_SIZE
  const statuses = q.status ?? []
  const statusMatch = q.statusMatch ?? 'any'
  const { candidates, rooms, refs, options } = await derive(ctx, scope, range, {
    floorId: q.floorId,
    roomTypeId: q.roomTypeId,
    q: q.q,
    includeOutOfInventory: q.includeOutOfInventory ?? false,
    withRefs: true,
  })

  // `rooms` keeps the candidates' order (floor level, natural room number, id). Segments are derived
  // for every candidate only when a derived filter needs them; otherwise only for the page.
  const derivedFilter = statuses.length > 0 || q.minCapacity !== undefined || q.maxCapacity !== undefined
  let matching: Array<{ room: InventoryRoomInput, segments: CalendarSegment[] | null }> = rooms.map(room => ({ room, segments: null }))
  if (derivedFilter) {
    matching = rooms
      .map(room => ({ room, segments: buildRoomSegments(room, range, options) }))
      .filter(r => matchesStatusFilter(r.segments, statuses, statusMatch) && matchesCapacityFilter(r.segments, q.minCapacity, q.maxCapacity))
  }

  const pageRows = matching.slice((page - 1) * pageSize, page * pageSize)
  const periodRefs = new Map<string, CalendarRefsDto['periods'][string]>()
  const blockRefs = new Map<string, CalendarRefsDto['blocks'][string]>()
  const pageRooms = pageRows.map(({ room, segments }) => {
    const segs = segments ?? buildRoomSegments(room, range, options)
    for (const s of segs) {
      if (s.periodId !== null && !periodRefs.has(s.periodId)) {
        const period = refs.periods.get(s.periodId)
        if (period) periodRefs.set(s.periodId, { name: period.name, kind: period.kind, startDate: period.startDate, endDate: period.endDate })
      }
      for (const blockId of s.blockIds) {
        if (blockRefs.has(blockId)) continue
        const block = refs.blocks.get(blockId)
        if (block) blockRefs.set(blockId, { kind: block.kind, startDate: block.startDate, endDate: block.endDate, reason: block.reason })
      }
    }
    const candidate = candidates.get(room.roomId)!
    return {
      roomId: room.roomId,
      roomNumber: candidate.roomNumber,
      floor: { ...candidate.floor },
      roomType: { ...candidate.roomType },
      features: [...candidate.features],
      segments: segs,
    }
  })

  const dto: RoomCalendarDto = {
    range,
    page,
    pageSize,
    total: matching.length,
    meta: { today: todayInTimezone(hotel.timezone, ctx.now()), maintenanceBlocksSales: options.maintenanceBlocksSales },
    refs: { periods: Object.fromEntries(periodRefs), blocks: Object.fromEntries(blockRefs) },
    rooms: pageRooms,
  }
  assertCalendarResponseWithinBudget(dto)
  return dto
}

/**
 * Daily totals over `from…to` (`room.view`; inactive hotels are readable) for every room matching the
 * structural `floorId`/`roomTypeId` filters: `summarizeDaily` over the same derived inputs as the
 * calendar — one row per date, zeros (never NaN) when nothing is in inventory.
 */
export async function getDailySummary(ctx: AuthContext, hotelId: string, q: DailySummaryInput): Promise<DailySummaryDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  assertValidInput(q)

  const range: NightRange = { from: q.from, to: q.to }
  const { rooms, options } = await derive(ctx, scope, range, { floorId: q.floorId, roomTypeId: q.roomTypeId, includeOutOfInventory: false, withRefs: false })

  return {
    range,
    meta: { today: todayInTimezone(hotel.timezone, ctx.now()), maintenanceBlocksSales: options.maintenanceBlocksSales },
    days: summarizeDaily(rooms, range, options),
  }
}
