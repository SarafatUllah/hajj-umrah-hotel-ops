import { MAX_ELIGIBLE_ROOM_IDS } from '@hajj/contracts/constants/inventory'
import { averageWindowIssues } from '@hajj/contracts/schemas/capacityAverages'
import { type IsoDate, type NightRange, isValidIsoDate, rangeFromStay, todayInTimezone } from '@hajj/contracts/utils/dates'
import { type AverageResult, baseHotelAverage, combineAverages, dateEffectiveHotelAverage, rangeEffectiveAverage } from '../domain/inventory/averages'
import { availableStayAverage } from '../domain/inventory/calendar'
import { hasHotelAccess } from '../domain/rbac/authorize'
import { ValidationError } from '../errors/domainError'
import { hotelRepos, tenantRepos } from '../repositories'
import { calendarOptionsFor } from './calendarOptions'
import type { HotelRow } from '../repositories/tenant'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel, requireOrgPermission } from '../security/authorize'
import type { HotelScope } from '../security/scope'
import type { AverageDto, RangeAverageDto, AvailableStayDto, HotelAveragesDto, PerHotelAveragesDto, OrganizationAveragesDto } from '@hajj/contracts/types/inventory'

export type { AverageDto, RangeAverageDto, AvailableStayDto, HotelAveragesDto, PerHotelAveragesDto, OrganizationAveragesDto }

export interface HotelAveragesInput {
  date?: IsoDate
  from?: IsoDate
  to?: IsoDate
  stayCheckIn?: IsoDate
  stayCheckOut?: IsoDate
  includeRoomIds?: boolean
}

export interface OrganizationAveragesInput {
  date?: IsoDate
  hotelIds?: readonly string[]
}

/** Copies exactly the five response keys — a domain result is never returned by reference. */
function toAverageDto(a: AverageResult): AverageDto {
  return { numerator: a.numerator, denominator: a.denominator, value: a.value, display: a.display, basis: a.basis }
}

/** Defensive re-check for direct callers (the HTTP boundary already rejected these via the zod schema). */
function assertValidInput(q: HotelAveragesInput): void {
  for (const value of [q.date, q.from, q.to, q.stayCheckIn, q.stayCheckOut]) {
    if (value !== undefined && !isValidIsoDate(value)) throw new ValidationError('INVALID_DATE', 'Dates must be valid YYYY-MM-DD dates')
  }
  const [issue] = averageWindowIssues(q)
  if (issue) throw new ValidationError(issue.code, issue.message, { path: issue.path })
}


/**
 * `room.view` on one hotel (inactive hotels are readable). `base`/`dateEffective` on `date` (default:
 * the hotel-local today), `range` over `from…to` (weighted by room-nights), `availableStay` over the
 * stay `[stayCheckIn, stayCheckOut)` honoring `inventory.maintenanceBlocksSales`. Statements: the
 * hotel read (authorization), at most one settings read (only with a stay), and one inventory load of
 * three queries (four with a stay) — never one per room or per night.
 */
export async function getHotelAverages(ctx: AuthContext, hotelId: string, q: HotelAveragesInput): Promise<HotelAveragesDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'room.view', hotelId, { allowInactive: true })
  assertValidInput(q)

  const date = q.date ?? todayInTimezone(hotel.timezone, ctx.now())
  const range: NightRange | null = q.from !== undefined && q.to !== undefined ? { from: q.from, to: q.to } : null
  const stay: NightRange | null = q.stayCheckIn !== undefined && q.stayCheckOut !== undefined ? rangeFromStay(q.stayCheckIn, q.stayCheckOut) : null

  // ONE load serves all four averages: rows overlapping the date, the range or the stay — each window
  // on its own, never the span between them (a far-away `date` must not pull in years of history).
  // Every domain function below only looks at its own window, whose rows are complete.
  const windows: NightRange[] = [{ from: date, to: date }]
  if (range) windows.push(range)
  if (stay) windows.push(stay)

  const [rooms, options] = await Promise.all([
    hotelRepos(ctx.db, scope).inventoryRead.loadRoomInputs(windows, { includeBlocks: stay !== null }),
    stay ? calendarOptionsFor(hotelRepos(ctx.db, scope)) : Promise.resolve(null),
  ])

  let availableStay: AvailableStayDto | null = null
  if (stay && options) {
    const result = availableStayAverage(rooms, stay, options)
    availableStay = { ...toAverageDto(result), checkIn: q.stayCheckIn!, checkOut: q.stayCheckOut!, eligibleRoomCount: result.eligibleRoomIds.length }
    if (q.includeRoomIds) availableStay.eligibleRoomIds = result.eligibleRoomIds.slice(0, MAX_ELIGIBLE_ROOM_IDS)
  }

  return {
    hotelId: hotel.id,
    date,
    base: toAverageDto(baseHotelAverage(rooms, date)),
    dateEffective: toAverageDto(dateEffectiveHotelAverage(rooms, date)),
    range: range ? { ...toAverageDto(rangeEffectiveAverage(rooms, range)), from: range.from, to: range.to } : null,
    availableStay,
  }
}

function byNameThenCode(a: HotelRow, b: HotelRow): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.code !== b.code) return a.code < b.code ? -1 : 1
  return 0
}

/**
 * Organization-wide `base`/`dateEffective`: `room.view` at organization level; the hotel set is every
 * accessible ACTIVE hotel, or exactly `hotelIds` (each must be accessible — a foreign, inaccessible or
 * nonexistent id is the same 404 `authorizeHotel` gives everywhere). Each hotel goes through
 * `authorizeHotel` and is evaluated on the explicit `date`, or on its OWN hotel-local today (S12).
 * The totals are `combineAverages` of the per-hotel results — sums of numerators over sums of
 * denominators, never a mean of the hotels' averages.
 */
export async function getOrganizationAverages(ctx: AuthContext, q: OrganizationAveragesInput): Promise<OrganizationAveragesDto> {
  requireOrgPermission(ctx, 'room.view')

  let candidateIds: string[]
  if (q.hotelIds !== undefined) {
    candidateIds = [...new Set(q.hotelIds)]
  }
  else {
    const all = await tenantRepos(ctx.db, ctx.scope).hotels.listAll()
    candidateIds = all.filter(h => h.status === 'ACTIVE' && hasHotelAccess(ctx.authz, h.id)).map(h => h.id)
  }

  // Authorize EVERY hotel before loading any inventory, so a bad id fails the request without work.
  const authorized: Array<{ hotel: HotelRow, scope: HotelScope }> = []
  for (const id of candidateIds) authorized.push(await authorizeHotel(ctx, 'room.view', id, { allowInactive: true }))
  authorized.sort((a, b) => byNameThenCode(a.hotel, b.hotel))
  if (q.date !== undefined && !isValidIsoDate(q.date)) throw new ValidationError('INVALID_DATE', 'Dates must be valid YYYY-MM-DD dates')

  // ONE instant for the whole request: every hotel's local today is derived from the same clock reading.
  const now = ctx.now()
  const perHotel: PerHotelAveragesDto[] = []
  for (const { hotel, scope } of authorized) {
    const date = q.date ?? todayInTimezone(hotel.timezone, now)
    const rooms = await hotelRepos(ctx.db, scope).inventoryRead.loadRoomInputs({ from: date, to: date }, { includeBlocks: false })
    perHotel.push({
      hotelId: hotel.id,
      code: hotel.code,
      name: hotel.name,
      date,
      base: toAverageDto(baseHotelAverage(rooms, date)),
      dateEffective: toAverageDto(dateEffectiveHotelAverage(rooms, date)),
    })
  }

  return {
    date: q.date ?? null,
    base: toAverageDto(combineAverages(perHotel.map(h => h.base))),
    dateEffective: toAverageDto(combineAverages(perHotel.map(h => h.dateEffective))),
    perHotel,
  }
}
