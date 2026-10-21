import { z } from 'zod'
import { CALENDAR_FILTER_STATUSES, type CalendarFilterStatus, DEFAULT_CALENDAR_PAGE_SIZE, MAX_BEDS_PER_ROOM, MAX_ROOMS_PER_PAGE } from '../constants/inventory'
import { averageWindowIssues } from './capacityAverages'
import { isoDate, uuid } from './common'

/**
 * Order/length/consistency rules shared by the schemas (422 at the HTTP boundary) and the service
 * (422 for a direct caller that bypassed the schema): `from <= to`, at most `MAX_CALENDAR_DAYS`
 * nights (the same rule — and codes — as the averages range), and `minCapacity <= maxCapacity`.
 * Dates that are not valid `YYYY-MM-DD` are reported by their own field and skipped here.
 */
export interface CalendarQueryIssue { path: string, code: 'INVALID_RANGE' | 'RANGE_TOO_LONG' | 'INVALID_CAPACITY_RANGE', message: string }

export function calendarQueryIssues(q: { from?: string, to?: string, minCapacity?: number, maxCapacity?: number }): CalendarQueryIssue[] {
  const issues: CalendarQueryIssue[] = []
  for (const issue of averageWindowIssues({ from: q.from, to: q.to })) {
    if (issue.code === 'INVALID_RANGE' || issue.code === 'RANGE_TOO_LONG') issues.push({ path: issue.path, code: issue.code, message: issue.message })
  }
  if (q.minCapacity !== undefined && q.maxCapacity !== undefined && q.minCapacity > q.maxCapacity) {
    issues.push({ path: 'maxCapacity', code: 'INVALID_CAPACITY_RANGE', message: '"maxCapacity" must not be below "minCapacity"' })
  }
  return issues
}

/** A non-negative integer written as plain digits (no sign, exponent, blank or repeated key): `''`, `-1`, `1e3`, `1.5` are all 422. */
const digits = z.string().regex(/^\d{1,6}$/, { message: 'Expected a non-negative integer' }).transform(Number)

const capacityBound = digits.pipe(z.number().int().min(0).max(MAX_BEDS_PER_ROOM))

/** `status=AVAILABLE,MAINTENANCE` — a comma list of the Phase 1 calendar statuses (de-duplicated); a repeated `status` key is a 422. */
const statusList = z.string().max(200).transform(raw => raw.split(',').map(s => s.trim())).pipe(z.array(z.enum(CALENDAR_FILTER_STATUSES)).min(1)).transform(list => [...new Set(list)] as CalendarFilterStatus[])

const flag = z.enum(['true', 'false']).optional().transform(v => v === 'true')

/**
 * `GET /api/hotels/:hotelId/room-calendar`. `from`/`to` (both required, inclusive nights, at most
 * `MAX_CALENDAR_DAYS`; a single date is `from = to`); structural filters `floorId`, `roomTypeId`, `q`
 * (room-number prefix, matched literally); derived filters `minCapacity`/`maxCapacity` (effective
 * sellable capacity on ANY night of the range), `status` + `statusMatch` (`any` default / `all`);
 * `includeOutOfInventory` (default `false`); `page` (from 1), `pageSize` (default 50, at most 200).
 * `.strict()`: an unknown query key is a 422; every scalar key must appear once.
 *
 * Response-size contract (not a query rule, so it is not validated here): the body of a 200 never exceeds
 * `MAX_CALENDAR_RESPONSE_BYTES` (2 MiB). A page that would is a 422 `CALENDAR_RESPONSE_TOO_LARGE`
 * (details `limitBytes`, `bytes`) — request a smaller `pageSize` or a shorter range. Other 422 codes
 * of this endpoint: `TOO_MANY_ROOMS` (more than 5,000 relevant candidate rooms), `INVALID_RANGE`,
 * `RANGE_TOO_LONG`, `INVALID_CAPACITY_RANGE`, `VALIDATION_FAILED`.
 */
export const roomCalendarQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  floorId: uuid.optional(),
  roomTypeId: uuid.optional(),
  q: z.string().max(40).optional(),
  minCapacity: capacityBound.optional(),
  maxCapacity: capacityBound.optional(),
  status: statusList.optional(),
  statusMatch: z.enum(['any', 'all']).optional().transform(v => v ?? 'any'),
  includeOutOfInventory: flag,
  page: digits.pipe(z.number().int().min(1)).optional().transform(v => v ?? 1),
  pageSize: digits.pipe(z.number().int().min(1).max(MAX_ROOMS_PER_PAGE)).optional().transform(v => v ?? DEFAULT_CALENDAR_PAGE_SIZE),
}).strict().superRefine((query, ctx) => {
  for (const issue of calendarQueryIssues(query)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message })
})

export type RoomCalendarQuery = z.infer<typeof roomCalendarQuerySchema>

/**
 * `GET /api/hotels/:hotelId/inventory/daily-summary`. `from`/`to` (both required, inclusive, at most
 * `MAX_CALENDAR_DAYS`) and the structural `floorId`/`roomTypeId` ONLY — the calendar-only filters
 * (`q`, capacity, status, paging) are unknown keys here (422).
 */
export const dailySummaryQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  floorId: uuid.optional(),
  roomTypeId: uuid.optional(),
}).strict().superRefine((query, ctx) => {
  for (const issue of calendarQueryIssues(query)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message })
})

export type DailySummaryQuery = z.infer<typeof dailySummaryQuerySchema>
