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

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
/** First character must be alphanumeric (so a leading hyphen is rejected); up to 20 characters total. */
const ROOM_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9./-]{0,19}$/

function mapArabicIndicDigits(value: string): string {
  return [...value].map((ch) => {
    const idx = ARABIC_INDIC_DIGITS.indexOf(ch)
    return idx === -1 ? ch : String(idx)
  }).join('')
}

export function normalizeRoomNumber(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  const mapped = mapArabicIndicDigits(trimmed).toUpperCase()
  return ROOM_NUMBER_PATTERN.test(mapped) ? mapped : null
}
