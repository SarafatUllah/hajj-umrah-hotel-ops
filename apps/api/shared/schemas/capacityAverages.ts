import { z } from 'zod'
import { MAX_AVERAGE_HOTEL_IDS, MAX_AVERAGE_STAY_NIGHTS, MAX_CALENDAR_DAYS } from '../constants/inventory'
import { isValidIsoDate, toEpochDay } from '../utils/dates'
import { isoDate, uniqueIds } from './common'

const includeRoomIdsFlag = z.enum(['true', 'false']).optional().transform(v => v === 'true')

/**
 * Order/length rules shared by the schema (422 at the HTTP boundary) and the service (422 for a
 * direct caller that bypassed the schema): `from`/`to` come together, `from <= to`, at most
 * `MAX_CALENDAR_DAYS` nights; `stayCheckIn`/`stayCheckOut` come together, `stayCheckOut > stayCheckIn`
 * (a stay `[checkIn, checkOut)` has at least one night), at most `MAX_AVERAGE_STAY_NIGHTS` nights.
 * Dates that are not valid `YYYY-MM-DD` are reported by their own field and skipped here.
 */
export interface AverageWindowIssue { path: string, code: 'INVALID_RANGE' | 'RANGE_TOO_LONG' | 'INVALID_STAY' | 'STAY_TOO_LONG', message: string }

export function averageWindowIssues(q: { from?: string, to?: string, stayCheckIn?: string, stayCheckOut?: string }): AverageWindowIssue[] {
  const issues: AverageWindowIssue[] = []

  if ((q.from === undefined) !== (q.to === undefined)) {
    issues.push({ path: q.from === undefined ? 'from' : 'to', code: 'INVALID_RANGE', message: '"from" and "to" must be given together' })
  }
  else if (q.from !== undefined && q.to !== undefined && isValidIsoDate(q.from) && isValidIsoDate(q.to)) {
    const nights = toEpochDay(q.to) - toEpochDay(q.from) + 1
    if (nights < 1) issues.push({ path: 'to', code: 'INVALID_RANGE', message: '"to" must not be before "from"' })
    else if (nights > MAX_CALENDAR_DAYS) issues.push({ path: 'to', code: 'RANGE_TOO_LONG', message: `Range must not exceed ${MAX_CALENDAR_DAYS} days` })
  }

  if ((q.stayCheckIn === undefined) !== (q.stayCheckOut === undefined)) {
    issues.push({ path: q.stayCheckIn === undefined ? 'stayCheckIn' : 'stayCheckOut', code: 'INVALID_STAY', message: '"stayCheckIn" and "stayCheckOut" must be given together' })
  }
  else if (q.stayCheckIn !== undefined && q.stayCheckOut !== undefined && isValidIsoDate(q.stayCheckIn) && isValidIsoDate(q.stayCheckOut)) {
    const nights = toEpochDay(q.stayCheckOut) - toEpochDay(q.stayCheckIn)
    if (nights < 1) issues.push({ path: 'stayCheckOut', code: 'INVALID_STAY', message: '"stayCheckOut" must be after "stayCheckIn"' })
    else if (nights > MAX_AVERAGE_STAY_NIGHTS) issues.push({ path: 'stayCheckOut', code: 'STAY_TOO_LONG', message: `A stay must not exceed ${MAX_AVERAGE_STAY_NIGHTS} nights` })
  }

  return issues
}

/**
 * `GET /api/hotels/:hotelId/capacity/averages?date&from&to&stayCheckIn&stayCheckOut&includeRoomIds`.
 * `date` (default: the hotel-local today, resolved by the service) drives `base`/`dateEffective`;
 * `from`/`to` (inclusive nights) drive `range`; `stayCheckIn`/`stayCheckOut` (`[checkIn, checkOut)`)
 * drive `availableStay`. `.strict()`: an unknown query key is a 422.
 */
export const hotelAveragesQuerySchema = z.object({
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  stayCheckIn: isoDate.optional(),
  stayCheckOut: isoDate.optional(),
  includeRoomIds: includeRoomIdsFlag,
}).strict().superRefine((query, ctx) => {
  for (const issue of averageWindowIssues(query)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message })
})

export type HotelAveragesQuery = z.infer<typeof hotelAveragesQuerySchema>

/** `hotelIds` accepts a comma list (`?hotelIds=a,b`) and/or a repeated key (`?hotelIds=a&hotelIds=b`). */
const hotelIdList = z.preprocess(
  raw => (typeof raw === 'string' || Array.isArray(raw) ? [raw].flat().flatMap(v => (typeof v === 'string' ? v.split(',') : [v])).map(v => (typeof v === 'string' ? v.trim() : v)) : raw),
  uniqueIds(MAX_AVERAGE_HOTEL_IDS),
)

/**
 * `GET /api/capacity/averages?date&hotelIds`. Without `date` every hotel is evaluated on its own
 * hotel-local today (S12); without `hotelIds` the set is every accessible ACTIVE hotel.
 */
export const organizationAveragesQuerySchema = z.object({
  date: isoDate.optional(),
  hotelIds: hotelIdList.optional(),
}).strict()

export type OrganizationAveragesQuery = z.infer<typeof organizationAveragesQuerySchema>
