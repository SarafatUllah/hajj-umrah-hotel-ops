import { z } from 'zod'
import { CAPACITY_PERIOD_KINDS, MAX_BEDS_PER_ROOM, MAX_OVERRIDE_SELECTOR_ROOMS } from '../constants/inventory'
import { isValidIsoDate, toEpochDay } from '../utils/dates'
import { dateRange, isoDate, safeText, uniqueIds, uuid } from './common'

const capacityValue = z.number().int().min(0).max(MAX_BEDS_PER_ROOM)
const physicalBedsValue = capacityValue.min(1)
/** A delta may be negative (shrinking) or positive; bounded loosely — the RESULT is what `computeOverrideValues` range-checks (422 `OVERRIDE_OUT_OF_RANGE`). */
const deltaValue = z.number().int().min(-MAX_BEDS_PER_ROOM).max(MAX_BEDS_PER_ROOM)

/** Max ids in a `floorIds`/`roomTypeIds` override selector — these are typically few; bounded the same way `MAX_ROOMS_PER_PAGE`-scale lists are elsewhere. */
const MAX_SELECTOR_GROUP_IDS = 200

export const createCapacityPeriodSchema = z.object({
  name: safeText(200),
  kind: z.enum(CAPACITY_PERIOD_KINDS),
  startDate: isoDate,
  endDate: isoDate,
  notes: safeText(2000).optional(),
}).strict().superRefine((body, ctx) => {
  // A length cap (MAX_CAPACITY_PERIOD_DAYS) is the service's job (assertPeriodRange, PF-13-style
  // friendly 422); only the ORDERING is checked here, at the schema layer, the same way `dateRange`
  // checks it for query ranges — `endDate < startDate` would otherwise reach `assertPeriodRange`'s
  // `makeRange()` and throw a raw `InvalidRangeError` there instead of this clean 422.
  if (isValidIsoDate(body.startDate) && isValidIsoDate(body.endDate) && toEpochDay(body.endDate) < toEpochDay(body.startDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: '"endDate" must not be before "startDate"' })
  }
})

export type CreateCapacityPeriodInput = z.infer<typeof createCapacityPeriodSchema>

/** `.strict()` rejects any key outside this list (mass-assignment guard) — `id`/`organizationId`/`hotelId` are never accepted. */
export const updateCapacityPeriodSchema = z.object({
  name: safeText(200).optional(),
  kind: z.enum(CAPACITY_PERIOD_KINDS).optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  notes: safeText(2000).nullable().optional(),
}).strict()

export type UpdateCapacityPeriodInput = z.infer<typeof updateCapacityPeriodSchema>

const includePastFlag = z.enum(['true', 'false']).optional().transform(v => v === 'true')

export const listCapacityPeriodsQuerySchema = z.object({
  includePast: includePastFlag,
}).strict()

export type ListCapacityPeriodsQuery = z.infer<typeof listCapacityPeriodsQuerySchema>

/**
 * Exactly one selector kind — `z.union` of four MUTUALLY `.strict()` object schemas: a body
 * combining two kinds (`{ floorIds: [...], roomTypeIds: [...] }`), or an empty `{}`, matches NONE of
 * the four and reports the generic 422 `VALIDATION_FAILED` (never silently picks one).
 */
/**
 * S9: `roomIds` holds at most `MAX_OVERRIDE_SELECTOR_ROOMS` ids AFTER de-duplication (duplicates are
 * removed before counting), so 1,000 distinct ids plus repeats are accepted. The raw array is still
 * bounded (a DoS guard, as in `uniqueIds`) — generously, at twice the distinct-id cap.
 */
const selectorRoomIds = z.array(uuid)
  .max(MAX_OVERRIDE_SELECTOR_ROOMS * 2, { message: `At most ${MAX_OVERRIDE_SELECTOR_ROOMS * 2} ids allowed` })
  .transform(ids => [...new Set(ids)])
  .refine(ids => ids.length > 0, { message: 'At least one id is required' })
  .refine(ids => ids.length <= MAX_OVERRIDE_SELECTOR_ROOMS, { message: `At most ${MAX_OVERRIDE_SELECTOR_ROOMS} distinct room ids allowed` })

export const overrideSelectorSchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ floorIds: uniqueIds(MAX_SELECTOR_GROUP_IDS) }).strict(),
  z.object({ roomTypeIds: uniqueIds(MAX_SELECTOR_GROUP_IDS) }).strict(),
  z.object({ roomIds: selectorRoomIds }).strict(),
])

export type OverrideSelector = z.infer<typeof overrideSelectorSchema>

export const overrideSpecSchema = z.union([
  z.object({ mode: z.literal('ABSOLUTE'), physicalBeds: physicalBedsValue, sellableCapacity: capacityValue }).strict(),
  z.object({ mode: z.literal('DELTA'), deltaBeds: deltaValue, deltaSellable: deltaValue }).strict(),
])

export type OverrideSpecInput = z.infer<typeof overrideSpecSchema>

export const applyOverridesSchema = z.object({
  selector: overrideSelectorSchema,
  spec: overrideSpecSchema,
  onConflict: z.enum(['FAIL', 'SKIP']).optional().default('FAIL'),
  reason: safeText(500).optional(),
}).strict()

export type ApplyOverridesInput = z.infer<typeof applyOverridesSchema>

export const removeOverridesSchema = z.object({
  overrideIds: uniqueIds(MAX_OVERRIDE_SELECTOR_ROOMS),
}).strict()

export type RemoveOverridesInput = z.infer<typeof removeOverridesSchema>

export const capacityTimelineQuerySchema = dateRange

export type CapacityTimelineQuery = z.infer<typeof capacityTimelineQuerySchema>

export const periodIdParams = z.object({ hotelId: uuid, periodId: uuid })
export const overrideIdParams = z.object({ hotelId: uuid, periodId: uuid, overrideId: uuid })
