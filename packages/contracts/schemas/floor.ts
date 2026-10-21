import { z } from 'zod'
import { safeText } from './common'

const LEVEL_MIN = -5
const LEVEL_MAX = 200
/** Max floors a single `bulk` request may create (DoS guard; local to this schema — not part of the shared inventory limits catalog). */
const MAX_BULK_FLOORS = 60

const level = z.number().int().min(LEVEL_MIN).max(LEVEL_MAX)

/**
 * `label` is optional on create: when omitted, the SERVICE applies the default (`"Ground"` for level
 * 0, `"Floor N"` otherwise) — never this schema, so the default logic lives in exactly one place.
 */
export const createFloorSchema = z.object({
  level,
  label: safeText(80).optional(),
}).strict()

export type CreateFloorInput = z.infer<typeof createFloorSchema>

/** `.strict()` so `id`/`hotelId`/`organizationId`/`isActive` are all 422s (mass-assignment), never silently dropped. */
export const updateFloorSchema = createFloorSchema.partial().strict()

export type UpdateFloorInput = z.infer<typeof updateFloorSchema>

export const bulkCreateFloorsSchema = z.object({
  fromLevel: level,
  toLevel: level,
}).strict().superRefine((range, ctx) => {
  if (range.toLevel < range.fromLevel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toLevel'], message: '"toLevel" must not be before "fromLevel"' })
    return
  }
  const requestedCount = range.toLevel - range.fromLevel + 1
  if (requestedCount > MAX_BULK_FLOORS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toLevel'], message: `A bulk request must not create more than ${MAX_BULK_FLOORS} floors` })
  }
})

export type BulkCreateFloorsInput = z.infer<typeof bulkCreateFloorsSchema>

/** Query-string flag: only the literal strings `'true'`/`'false'` are accepted — never a loosely-truthy coercion. */
const includeInactiveFlag = z.enum(['true', 'false']).optional().transform(v => v === 'true')

export const listFloorsQuerySchema = z.object({
  includeInactive: includeInactiveFlag,
}).strict()

export type ListFloorsQuery = z.infer<typeof listFloorsQuerySchema>
