import { z } from 'zod'
import { AUDIT_ACTIONS } from '../constants/audit'
import { OWNERSHIP_TYPES } from '../constants/inventory'
import { isValidIsoDate, isValidTimezone } from '../utils/dates'
import { safeText } from './common'

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/
const COUNTRY_PATTERN = /^[A-Z]{2}$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * The one hotel-creation/edit schema every field of `HotelDetail` traces back to. `.strict()` so an
 * unrecognized key (e.g. a client trying to set `status`/`id`/`organizationId` directly) is a 422,
 * never silently dropped or silently accepted (no mass assignment).
 */
export const createHotelSchema = z.object({
  code: z.string().regex(CODE_PATTERN, { message: 'Code must be 2-20 characters: uppercase letters, digits and hyphens, starting with a letter or digit' }),
  name: safeText(120),
  city: safeText(80),
  country: z.string().regex(COUNTRY_PATTERN, { message: 'Country must be a 2-letter uppercase ISO code' }).default('SA'),
  address: safeText(300).optional(),
  phone: safeText(40).optional(),
  email: z.string().email().max(254).optional(),
  timezone: z.string().refine(isValidTimezone, { message: 'Invalid IANA timezone' }),
  currency: z.string().regex(CURRENCY_PATTERN, { message: 'Currency must be a 3-letter uppercase ISO code' }).default('SAR'),
  checkInTime: z.string().regex(TIME_PATTERN, { message: 'Must be HH:MM (24h)' }).default('15:00'),
  checkOutTime: z.string().regex(TIME_PATTERN, { message: 'Must be HH:MM (24h)' }).default('12:00'),
  licenseReference: safeText(100).optional(),
  ownershipType: z.enum(OWNERSHIP_TYPES).default('OWNED'),
  notes: safeText(2000).optional(),
}).strict()

export type CreateHotelInput = z.infer<typeof createHotelSchema>

/** `code` is immutable after creation (domain rule) — never part of an update body. */
export const updateHotelSchema = createHotelSchema.omit({ code: true }).partial().strict()

export type UpdateHotelInput = z.infer<typeof updateHotelSchema>

/** Fixed list (S3): room/season/block histories are the same hotel audit-log endpoint, filtered. */
export const AUDIT_ENTITY_TYPES = ['hotel', 'floor', 'room', 'capacity_period', 'room_block', 'document'] as const

// btoa/atob (not node:Buffer) so this stays usable outside a Node-only server context — the cursor
// carries only ASCII (a timestamptz's text form + a uuid), so the Latin1 assumption is always safe.
function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=')
  return atob(padded)
}

export interface AuditCursorValue { createdAt: string, id: string }

const CURSOR_SHAPE_PATTERN = /^[A-Za-z0-9_-]+$/
const CURSOR_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Structurally matches Postgres's `timestamptz` text output (`created_at::text`, the cursor's
 * `createdAt` half — see `AuditRepository#listForHotel`): `YYYY-MM-DD HH:MM:SS`, optionally
 * followed by `.` + 1-6 fractional digits, optionally followed by an offset (`+00`, `+05:30`,
 * `-08`, or `Z`). Captures the date part, the H/M/S parts, and (if present) the offset sign/hour/
 * minute for plain numeric range checks below.
 */
const TIMESTAMPTZ_TEXT_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)?$/

/**
 * Validates a decoded cursor's `createdAt` half is a plausible `timestamptz` text value BEFORE it
 * can reach `AuditRepository#listForHotel`'s raw `::timestamptz` SQL cast — a malformed string
 * reaching that cast fails as a raw Postgres error, not the required 422 `VALIDATION_FAILED` (the
 * exact leak the error-model architecture exists to prevent).
 *
 * Deliberately never calls `new Date(string)`/`Date.parse` (Task 9 rule, guarded by
 * tests/unit/architecture/dateParsing.test.ts): the date portion is validated component-wise via
 * `isValidIsoDate` (the same technique it already uses — regex-extract, then check calendar
 * validity), and the time/offset portions are validated with plain numeric range checks.
 */
function isValidTimestamptzText(value: string): boolean {
  const m = TIMESTAMPTZ_TEXT_PATTERN.exec(value)
  if (!m) return false
  const [, datePart, hour, minute, second, offSign, offHour, offMinute] = m
  if (!isValidIsoDate(datePart!)) return false
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false
  if (offSign && (Number(offHour) > 14 || (offMinute !== undefined && Number(offMinute) > 59))) return false
  return true
}

/** `base64url(createdAt|id)` (PF-7's cursor scheme) — a malformed value never throws, it fails Zod (422). */
export const auditCursorSchema = z.string().regex(CURSOR_SHAPE_PATTERN, { message: 'Malformed cursor' }).transform((raw, ctx) => {
  let decoded: string
  try {
    decoded = base64UrlDecode(raw)
  }
  catch {
    decoded = ''
  }
  const sep = decoded.indexOf('|')
  const createdAt = sep >= 0 ? decoded.slice(0, sep) : ''
  const id = sep >= 0 ? decoded.slice(sep + 1) : ''
  if (!isValidTimestamptzText(createdAt) || !CURSOR_ID_PATTERN.test(id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Malformed cursor' })
    return z.NEVER
  }
  return { createdAt, id } satisfies AuditCursorValue
})

export function encodeAuditCursor(cursor: AuditCursorValue): string {
  return base64UrlEncode(`${cursor.createdAt}|${cursor.id}`)
}

export const listHotelAuditQuerySchema = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.string().min(1).max(200).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  cursor: auditCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()

export type ListHotelAuditQuery = z.infer<typeof listHotelAuditQuerySchema>
