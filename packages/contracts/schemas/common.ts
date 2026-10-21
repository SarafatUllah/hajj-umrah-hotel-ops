import { z } from 'zod'
import { isValidIsoDate, toEpochDay } from '../utils/dates'
import { MAX_CALENDAR_DAYS } from '../constants/inventory'

export const uuid = z.string().uuid()

/** `YYYY-MM-DD` only — delegates to `isValidIsoDate` so a calendar-invalid date (`2027-02-30`) or a non-date-only string (`2027-05-01T00:00`) is rejected, not just anything `Date`-parseable. */
export const isoDate = z.string().refine(isValidIsoDate, { message: 'Invalid date (expected YYYY-MM-DD)' })

/** An inclusive night range: `from` must not be after `to`, and the range may span at most `MAX_CALENDAR_DAYS` nights (DoS guard). */
export const dateRange = z.object({
  from: isoDate,
  to: isoDate,
}).superRefine((range, ctx) => {
  // The field-level `isoDate` schema already reported an invalid `from`/`to`
  // on its own path; skip the range check rather than calling `toEpochDay`
  // on a string it would reject (superRefine still runs against the
  // original — merely "dirty", not "aborted" — value in that case).
  if (!isValidIsoDate(range.from) || !isValidIsoDate(range.to)) return
  const fromDay = toEpochDay(range.from)
  const toDay = toEpochDay(range.to)
  if (toDay < fromDay) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '"to" must not be before "from"' })
    return
  }
  if (toDay - fromDay + 1 > MAX_CALENDAR_DAYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `Range must not exceed ${MAX_CALENDAR_DAYS} days` })
  }
})

/** Query-string pagination: coerces `page`/`pageSize` from strings, defaults `page` to 1 and `pageSize` to `min(20, maxPageSize)`, and caps `pageSize` at `maxPageSize`. */
export function pagination({ maxPageSize }: { maxPageSize: number }) {
  const defaultPageSize = Math.min(20, maxPageSize)
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(maxPageSize).default(defaultPageSize),
  })
}

// eslint-disable-next-line no-control-regex -- detecting C0 control characters (including NUL) is the point of this pattern.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** Free text from a client: NFC-normalizes, trims surrounding whitespace, rejects C0 control characters (including NUL), and enforces a maximum length. */
export function safeText(max: number) {
  return z.string()
    .transform(value => value.normalize('NFC').trim())
    .refine(value => !CONTROL_CHARS.test(value), { message: 'Must not contain control characters' })
    .refine(value => value.length <= max, { message: `Must be at most ${max} characters` })
}

/** An array of uuids, deduplicated, capped at `max` entries; non-empty is required unless `required: false` is passed. */
export function uniqueIds(max: number, opts: { required?: boolean } = {}) {
  const required = opts.required ?? true
  return z.array(uuid)
    // Bound the RAW input array length before deduplicating — zod's own
    // `.max()` check runs against the array as received, before element
    // parsing/transform, so an oversized array of duplicate uuids (e.g.
    // 10,000 copies of the same valid id) is rejected here rather than
    // shrinking to 1 distinct id and slipping past the cap.
    .max(max, { message: `At most ${max} ids allowed` })
    .transform(ids => [...new Set(ids)])
    .refine(ids => !required || ids.length > 0, { message: 'At least one id is required' })
}
