/**
 * ICAO Doc 9303 machine-readable zone of a passport (TD3: two lines of 44 characters), read from OCR text (v7 §13:
 * "MRZ on our own server, check digits verified"). Pure: no image handling here.
 *
 * Line 1: `P<` + issuing state (3) + `SURNAME<<GIVEN<NAMES` (39).
 * Line 2: number (9) + check, nationality (3), birth YYMMDD + check, sex, expiry YYMMDD + check, optional (14) +
 * check, composite check over number, birth, expiry and optional data with their checks.
 */

export const MRZ_LINE_LENGTH = 44

export interface MrzFields {
  issuingState: string
  surname: string
  givenNames: string
  passportNo: string
  nationality: string
  /** `YYYY-MM-DD`; the century is inferred (see `birthDate`). */
  dateOfBirth: string
  sex: 'MALE' | 'FEMALE' | null
  passportExpiry: string
}

export interface MrzChecks { passportNo: boolean, dateOfBirth: boolean, passportExpiry: boolean, composite: boolean }

export interface MrzReading { fields: MrzFields, checks: MrzChecks, lines: [string, string] }

const charValue = (c: string): number => (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55)

/** The 7-3-1 weighted check digit of ICAO 9303. */
export function checkDigit(value: string): number {
  const weights = [7, 3, 1]
  let sum = 0
  for (let i = 0; i < value.length; i++) sum += charValue(value[i]!) * weights[i % 3]!
  return sum % 10
}

const matches = (value: string, digit: string) => /\d/.test(digit) && checkDigit(value) === Number(digit)

// OCR confuses letters and digits; each MRZ position is one or the other, so it can be repaired by position.
const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' }
const TO_LETTER: Record<string, string> = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 6: 'G', 8: 'B' }
const digits = (s: string) => s.replace(/[A-Z]/g, c => TO_DIGIT[c] ?? c)
const letters = (s: string) => s.replace(/\d/g, c => TO_LETTER[c] ?? c)

/** Line 2 repaired field by field (number and optional data stay as read: they may hold both). */
function repairLine2(line: string): string {
  return [
    line.slice(0, 9), digits(line.slice(9, 10)), letters(line.slice(10, 13)), digits(line.slice(13, 20)), line.slice(20, 21),
    digits(line.slice(21, 28)), line.slice(28, 42), digits(line.slice(42, 44)),
  ].join('')
}

/** A YYMMDD birth date: the latest century that does not put it after `today`. */
function birthDate(yymmdd: string, today: string): string {
  const year = 2000 + Number(yymmdd.slice(0, 2))
  const iso = `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
  return iso > today ? `${year - 100}${iso.slice(4)}` : iso
}

/** A YYMMDD expiry date: passports issued this century expire in it. */
const expiryDate = (yymmdd: string) => `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`

const isDate = (iso: string) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso)

/** The two MRZ lines in OCR text: a `P` line followed by a line of the second line's shape (spaces dropped, `«` read as `<`). */
export function findMrzLines(text: string): [string, string] | null {
  const lines = text.split(/\r?\n/)
    .map(l => l.toUpperCase().replace(/«/g, '<').replace(/\s+/g, ''))
    .filter(l => l.length >= MRZ_LINE_LENGTH - 2 && /^[A-Z0-9<]+$/.test(l))
  for (let i = 0; i + 1 < lines.length; i++) {
    const first = lines[i]!
    const second = lines[i + 1]!
    if (first.startsWith('P') && /^[A-Z0-9<]{9}[0-9OQDILZSGB]/.test(second)) {
      const pad = (l: string) => l.slice(0, MRZ_LINE_LENGTH).padEnd(MRZ_LINE_LENGTH, '<')
      return [pad(first), pad(second)]
    }
  }
  return null
}

/**
 * Parses TD3 lines (repaired by position). null = not a passport MRZ or unusable dates. `today` decides the century
 * of the birth date. A failed check digit does not discard the reading — the review form marks those fields.
 */
export function parseMrz(lines: readonly [string, string], today: string): MrzReading | null {
  const [line1, raw2] = lines
  if (line1.length !== MRZ_LINE_LENGTH || raw2.length !== MRZ_LINE_LENGTH || !line1.startsWith('P')) return null
  const line2 = repairLine2(raw2)
  const [surname = '', ...given] = letters(line1.slice(5)).split('<<')
  const fields: MrzFields = {
    issuingState: letters(line1.slice(2, 5)).replace(/</g, ''),
    surname: surname.replace(/</g, ' ').trim(),
    givenNames: given.join(' ').replace(/</g, ' ').replace(/\s+/g, ' ').trim(),
    passportNo: line2.slice(0, 9).replace(/</g, ''),
    nationality: line2.slice(10, 13).replace(/</g, ''),
    dateOfBirth: birthDate(line2.slice(13, 19), today),
    sex: line2[20] === 'M' ? 'MALE' : line2[20] === 'F' ? 'FEMALE' : null,
    passportExpiry: expiryDate(line2.slice(21, 27)),
  }
  if (!isDate(fields.dateOfBirth) || !isDate(fields.passportExpiry) || !/^[A-Z]{3}$/.test(fields.nationality)) return null
  const checks: MrzChecks = {
    passportNo: matches(line2.slice(0, 9), line2[9]!),
    dateOfBirth: matches(line2.slice(13, 19), line2[19]!),
    passportExpiry: matches(line2.slice(21, 27), line2[27]!),
    composite: matches(line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43), line2[43]!),
  }
  return { fields, checks, lines: [line1, line2] }
}
