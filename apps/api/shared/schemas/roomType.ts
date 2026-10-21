import { z } from 'zod'
import { safeText } from './common'

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/

/**
 * `defaultSellableCapacity` deliberately has no relation enforced against `defaultPhysicalBeds` —
 * sellable may be lower than, equal to, or GREATER than physical beds (extra sellable capacity beyond
 * physical beds is a real scenario in this domain), so no cross-field `.superRefine` is added here.
 */
export const createRoomTypeSchema = z.object({
  code: z.string().regex(CODE_PATTERN, { message: 'Code must be 2-20 characters: uppercase letters, digits, underscores and hyphens, starting with a letter or digit' }),
  name: safeText(120),
  description: safeText(500).optional(),
  defaultPhysicalBeds: z.number().int().min(1).max(30).default(4),
  defaultSellableCapacity: z.number().int().min(0).max(30).default(4),
  sortOrder: z.number().int().min(0).max(1000).default(0),
}).strict()

export type CreateRoomTypeInput = z.infer<typeof createRoomTypeSchema>

/** `.partial().strict()` — `id`/`organizationId`/`isActive` were never fields of the base schema, so any attempt to set them is a 422. */
export const updateRoomTypeSchema = createRoomTypeSchema.partial().strict()

export type UpdateRoomTypeInput = z.infer<typeof updateRoomTypeSchema>

/** Query-string flag: only the literal strings `'true'`/`'false'` are accepted — never a loosely-truthy coercion. */
const includeInactiveFlag = z.enum(['true', 'false']).optional().transform(v => v === 'true')

export const listRoomTypesQuerySchema = z.object({
  includeInactive: includeInactiveFlag,
}).strict()

export type ListRoomTypesQuery = z.infer<typeof listRoomTypesQuerySchema>
