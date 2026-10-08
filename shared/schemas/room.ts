import { z } from 'zod'
import { MAX_BEDS_PER_ROOM, MAX_BULK_ROOMS, MAX_ROOMS_PER_PAGE, ROOM_FEATURES } from '../constants/inventory'
import { isoDate, pagination, safeText, uuid } from './common'

/**
 * Room numbers are accepted here only as raw text (a generous length bound, no format check) —
 * `normalizeRoomNumber` (shared/utils/roomNumber.ts) is the single place that trims, upper-cases,
 * maps Arabic-Indic digits, and validates the shape; the SERVICE calls it and reports a friendly
 * `422 INVALID_ROOM_NUMBER` for anything that fails to normalize, rather than duplicating the pattern
 * here where a client's pre-normalization text (' 401 ', '٤٠١') would otherwise be rejected too early.
 */
const rawRoomNumber = z.string().min(1).max(40)

const featureList = z.array(z.enum(ROOM_FEATURES)).max(ROOM_FEATURES.length)
const capacityValue = z.number().int().min(0).max(MAX_BEDS_PER_ROOM)
const physicalBedsValue = capacityValue.min(1)

export const createRoomSchema = z.object({
  floorId: uuid,
  roomTypeId: uuid,
  roomNumber: rawRoomNumber,
  inServiceFrom: isoDate,
  physicalBeds: physicalBedsValue.optional(),
  sellableCapacity: capacityValue.optional(),
  features: featureList.default([]),
  notes: safeText(2000).optional(),
}).strict()

export type CreateRoomInput = z.infer<typeof createRoomSchema>

/**
 * `.strict()` rejects any key outside this list with the generic unrecognized-keys 422. `roomNumber`
 * is deliberately ALLOWED through the schema (as opaque, unvalidated text) rather than being
 * rejected here as an unknown key — this lets the SERVICE distinguish "you tried to rename this room"
 * (422 `ROOM_NUMBER_IMMUTABLE`, a specific, documented code) from every other unknown key (generic
 * `VALIDATION_FAILED`), which a `.strict()` rejection alone cannot do (every unrecognized key
 * produces the same generic error). Capacity fields (`physicalBeds`/`sellableCapacity`) and
 * `id`/`organizationId`/`hotelId` are NOT listed here, so they fall through to the generic 422 —
 * capacity only ever changes through the base-config workflow.
 */
export const updateRoomSchema = z.object({
  floorId: uuid.optional(),
  roomTypeId: uuid.optional(),
  features: featureList.optional(),
  notes: safeText(2000).nullable().optional(),
  roomNumber: z.string().optional(),
}).strict()

export type UpdateRoomInput = z.infer<typeof updateRoomSchema>

export const changeBaseConfigSchema = z.object({
  effectiveFrom: isoDate,
  physicalBeds: physicalBedsValue,
  sellableCapacity: capacityValue,
  reason: safeText(500).optional(),
}).strict()

export type ChangeBaseConfigInput = z.infer<typeof changeBaseConfigSchema>

export const retireRoomSchema = z.object({
  effectiveFrom: isoDate,
  reason: safeText(500).optional(),
}).strict()

export type RetireRoomInput = z.infer<typeof retireRoomSchema>

export const reactivateRoomSchema = z.object({
  effectiveFrom: isoDate,
  physicalBeds: physicalBedsValue,
  sellableCapacity: capacityValue,
  reason: safeText(500).optional(),
}).strict()

export type ReactivateRoomInput = z.infer<typeof reactivateRoomSchema>

const bulkRangeSchema = z.object({
  prefix: z.string().max(10).optional(),
  from: z.number().int().min(0).max(999_999),
  to: z.number().int().min(0).max(999_999),
  pad: z.number().int().min(0).max(10).optional(),
}).strict()

export const bulkCreateRoomsSchema = z.object({
  floorId: uuid,
  roomTypeId: uuid,
  inServiceFrom: isoDate,
  numbers: z.array(rawRoomNumber).min(1).max(MAX_BULK_ROOMS).optional(),
  range: bulkRangeSchema.optional(),
  physicalBeds: physicalBedsValue.optional(),
  sellableCapacity: capacityValue.optional(),
}).strict().superRefine((body, ctx) => {
  const hasNumbers = body.numbers !== undefined
  const hasRange = body.range !== undefined
  if (hasNumbers === hasRange) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Exactly one of "numbers" or "range" must be provided' })
    return
  }
  if (hasRange) {
    const { from, to } = body.range!
    if (to < from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['range', 'to'], message: '"to" must not be before "from"' })
      return
    }
    const generatedCount = to - from + 1
    if (generatedCount > MAX_BULK_ROOMS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['range', 'to'], message: `A bulk request must not generate more than ${MAX_BULK_ROOMS} room numbers` })
    }
  }
})

export type BulkCreateRoomsInput = z.infer<typeof bulkCreateRoomsSchema>

/** Query-string flag: only the literal strings `'true'`/`'false'` are accepted — never a loosely-truthy coercion. */
const inventoryFilter = z.enum(['IN', 'OUT', 'ALL']).optional()

// `.shape` (not `.merge`) so the combined schema stays `.strict()` — `pagination()` returns a plain
// (non-strict) object, and ZodObject#merge adopts the SECOND schema's unknownKeys behavior, which
// would silently re-open this schema to arbitrary extra query params.
export const listRoomsQuerySchema = z.object({
  asOf: isoDate.optional(),
  floorId: uuid.optional(),
  roomTypeId: uuid.optional(),
  q: z.string().max(40).optional(),
  inventory: inventoryFilter,
  ...pagination({ maxPageSize: MAX_ROOMS_PER_PAGE }).shape,
}).strict()

export type ListRoomsQuery = z.infer<typeof listRoomsQuerySchema>
