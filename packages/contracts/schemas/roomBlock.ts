import { z } from 'zod'
import { BLOCK_KINDS, MAX_BULK_ROOMS, MAX_ROOMS_PER_PAGE } from '../constants/inventory'
import { isValidIsoDate, toEpochDay } from '../utils/dates'
import { dateRange, isoDate, pagination, safeText, uniqueIds, uuid } from './common'

/** Required free text: trimmed/NFC-normalized by `safeText`, then non-blank (the DB's `room_block_reason_check` is the backstop). */
const requiredReason = safeText(500).refine(value => value.length > 0, { message: 'A reason is required' })

/**
 * `endDate < startDate` is rejected here (a clean 422) rather than reaching `assertBlockCreatable`'s
 * `makeRange()`; the start-in-the-past and 731-night rules need the hotel's today, so they live in
 * the service (`assertBlockCreatable`).
 */
function endNotBeforeStart(body: { startDate: string, endDate: string }, ctx: z.RefinementCtx) {
  if (isValidIsoDate(body.startDate) && isValidIsoDate(body.endDate) && toEpochDay(body.endDate) < toEpochDay(body.startDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: '"endDate" must not be before "startDate"' })
  }
}

/** `POST …/rooms/:roomId/blocks`. `.strict()`: no `roomId`/`hotelId`/`organizationId`/cancellation fields from the body. */
export const createRoomBlockSchema = z.object({
  kind: z.enum(BLOCK_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  reason: requiredReason,
}).strict().superRefine(endNotBeforeStart)

export type CreateRoomBlockInput = z.infer<typeof createRoomBlockSchema>

const bulkBase = {
  kind: z.enum(BLOCK_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  reason: requiredReason,
}

/**
 * `POST …/room-blocks/bulk`: exactly one selector — `roomIds` (1..MAX_BULK_ROOMS distinct ids) or
 * `floorId` — via a union of two mutually `.strict()` objects, so a body with both (or neither)
 * matches neither branch and is a generic 422.
 */
export const bulkCreateRoomBlocksSchema = z.union([
  z.object({ ...bulkBase, roomIds: uniqueIds(MAX_BULK_ROOMS) }).strict(),
  z.object({ ...bulkBase, floorId: uuid }).strict(),
]).superRefine(endNotBeforeStart)

export type BulkCreateRoomBlocksInput = z.infer<typeof bulkCreateRoomBlocksSchema>

export const cancelRoomBlockSchema = z.object({
  reason: requiredReason,
}).strict()

export type CancelRoomBlockInput = z.infer<typeof cancelRoomBlockSchema>

const includeCancelledFlag = z.enum(['true', 'false']).optional().transform(v => v === 'true')

/**
 * `GET …/room-blocks?from&to&roomId&kind&includeCancelled&page&pageSize`: the window is required and
 * bounded by `MAX_CALENDAR_DAYS` (`dateRange`); `pageSize ≤ MAX_ROOMS_PER_PAGE` (200). `.shape`
 * spreads (not `.merge`) keep the whole object `.strict()`.
 */
export const listRoomBlocksQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  roomId: uuid.optional(),
  kind: z.enum(BLOCK_KINDS).optional(),
  includeCancelled: includeCancelledFlag,
  ...pagination({ maxPageSize: MAX_ROOMS_PER_PAGE }).shape,
}).strict().superRefine((query, ctx) => {
  // An invalid `from`/`to` was already reported by its own field schema; only order/length remain.
  if (!isValidIsoDate(query.from) || !isValidIsoDate(query.to)) return
  const range = dateRange.safeParse({ from: query.from, to: query.to })
  if (!range.success) for (const issue of range.error.issues) ctx.addIssue(issue)
})

export type ListRoomBlocksQuery = z.infer<typeof listRoomBlocksQuerySchema>
