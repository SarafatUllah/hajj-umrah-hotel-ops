export type IsoDate = string

export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Invalid ISO date: ${value}`)
    this.name = 'InvalidDateError'
  }
}
export class InvalidRangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRangeError'
  }
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/
const MIN_YEAR = 1900
const MAX_YEAR = 2200
const MS_PER_DAY = 86_400_000

export function isValidIsoDate(value: string): boolean {
  const m = ISO.exec(value)
  if (!m) return false
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (y < MIN_YEAR || y > MAX_YEAR) return false
  const t = new Date(0)
  t.setUTCFullYear(y, mo - 1, d)
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

export function toEpochDay(date: IsoDate): number {
  if (!isValidIsoDate(date)) throw new InvalidDateError(date)
  const m = ISO.exec(date)!
  const t = new Date(0)
  t.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.round(t.getTime() / MS_PER_DAY)
}

export function fromEpochDay(day: number): IsoDate {
  const t = new Date(day * MS_PER_DAY)
  const y = String(t.getUTCFullYear()).padStart(4, '0')
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0')
  const d = String(t.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return fromEpochDay(toEpochDay(date) + n)
}

/** Inclusive first and last NIGHT of a range (a night is identified by the date it starts). */
export interface NightRange { from: IsoDate, to: IsoDate }

export function makeRange(from: IsoDate, to: IsoDate): NightRange {
  if (toEpochDay(to) < toEpochDay(from)) throw new InvalidRangeError(`Range end ${to} is before start ${from}`)
  return { from, to }
}

export function rangeLength(r: NightRange): number {
  return toEpochDay(r.to) - toEpochDay(r.from) + 1
}

export function containsDate(r: NightRange, d: IsoDate): boolean {
  const e = toEpochDay(d)
  return e >= toEpochDay(r.from) && e <= toEpochDay(r.to)
}

export function rangesOverlap(a: NightRange, b: NightRange): boolean {
  return toEpochDay(a.from) <= toEpochDay(b.to) && toEpochDay(b.from) <= toEpochDay(a.to)
}

export function intersect(a: NightRange, b: NightRange): NightRange | null {
  if (!rangesOverlap(a, b)) return null
  const from = toEpochDay(a.from) >= toEpochDay(b.from) ? a.from : b.from
  const to = toEpochDay(a.to) <= toEpochDay(b.to) ? a.to : b.to
  return { from, to }
}

/** A stay [checkIn, checkOut) occupies the nights checkIn .. checkOut-1. */
export function rangeFromStay(checkIn: IsoDate, checkOut: IsoDate): NightRange {
  if (toEpochDay(checkOut) <= toEpochDay(checkIn)) throw new InvalidRangeError('checkOut must be after checkIn')
  return { from: checkIn, to: addDays(checkOut, -1) }
}

export function eachDate(r: NightRange, maxDays = 1000): IsoDate[] {
  const len = rangeLength(r)
  if (len > maxDays) throw new InvalidRangeError(`Range of ${len} days exceeds the maximum of ${maxDays}`)
  const start = toEpochDay(r.from)
  return Array.from({ length: len }, (_, i) => fromEpochDay(start + i))
}

/** Today's calendar date in a hotel's IANA timezone (never the server's or browser's). */
export function todayInTimezone(timezone: string, now: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    return true
  }
  catch {
    return false
  }
}
