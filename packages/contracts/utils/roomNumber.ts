/**
 * Room-number normalization (Task 14, D16). Trims, upper-cases Latin letters, maps Arabic-Indic
 * digits to ASCII, then validates the result against a strict display/lookup pattern. Returns `null`
 * for anything that does not normalize to a valid room number — mirrors `isValidIsoDate`'s
 * boolean/nullable-return convention (`shared/utils/dates.ts`) rather than throwing, since callers
 * (schemas, the bulk-create service) need to report a friendly validation error, not catch an
 * exception.
 *
 * Room numbers are unique per hotel for their ENTIRE LIFETIME (Q2) and immutable after creation
 * (D16) — this module only normalizes text; lifetime uniqueness is enforced by the database's
 * `room_hotel_number_unique` constraint on the permanent `room` table (no soft-delete, no status
 * column, so a number can never be "freed up").
 */

import { toLatinDigits } from './digits'

/** First character must be alphanumeric (so a leading hyphen is rejected); up to 20 characters total. */
const ROOM_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9./-]{0,19}$/

export function normalizeRoomNumber(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  const mapped = toLatinDigits(trimmed).toUpperCase()
  return ROOM_NUMBER_PATTERN.test(mapped) ? mapped : null
}

/** A bulk creation's number range (`POST …/rooms/bulk`): a prefix, then each number from `from` to `to`, padded to `pad` digits. */
export interface RoomNumberRange { prefix?: string, from: number, to: number, pad?: number }

/** The room numbers a range creates, before normalization — the API's own list, and the form's preview of it. */
export function roomNumbersOfRange(range: RoomNumberRange): string[] {
  const out: string[] = []
  for (let n = range.from; n <= range.to; n++) {
    const digits = range.pad ? String(n).padStart(range.pad, '0') : String(n)
    out.push(`${range.prefix ?? ''}${digits}`)
  }
  return out
}
