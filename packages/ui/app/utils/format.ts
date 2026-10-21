import { toEpochDay } from '@hajj/contracts/utils/dates'
import { HALALAS_PER_RIYAL } from '@hajj/contracts/utils/money'

/**
 * Formatting (§13, D5): Gregorian dates and Western digits in both languages — Arabic as `ar-SA` with the Latin
 * numbering system and the Gregorian calendar (plain `ar-SA` would give Arabic-Indic digits and Umm al-Qura).
 * Hotel dates (`YYYY-MM-DD`) are calendar dates: formatted in UTC, never through the browser's time zone.
 */
export function localeTag(locale: string): string {
  return locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB-u-ca-gregory'
}

const MS_PER_DAY = 86_400_000

/** A hotel date as an instant at UTC midnight, only for formatting (date arithmetic stays on epoch days). */
const utcDate = (isoDate: string): Date => new Date(toEpochDay(isoDate) * MS_PER_DAY)

export type DateStyle = 'short' | 'medium' | 'long'

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { day: 'numeric', month: 'short' },
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  long: { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' },
}

// One formatter per language and style: building an `Intl.DateTimeFormat` costs far more than using one, and a
// calendar formats hundreds of dates per render.
const dateFormatters = new Map<string, Intl.DateTimeFormat>()
function dateFormatter(locale: string, style: DateStyle): Intl.DateTimeFormat {
  const key = `${locale}|${style}`
  const known = dateFormatters.get(key)
  if (known) return known
  const formatter = new Intl.DateTimeFormat(localeTag(locale), { ...DATE_OPTIONS[style], timeZone: 'UTC' })
  dateFormatters.set(key, formatter)
  return formatter
}

/** "1 Jun 2027" (medium), "1 Jun" (short), "Tue, 1 June 2027" (long). */
export function formatDate(isoDate: string, locale: string, style: DateStyle = 'medium'): string {
  return dateFormatter(locale, style).format(utcDate(isoDate))
}

/** The nights of a stay `[checkIn, checkOut)`. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return toEpochDay(checkOut) - toEpochDay(checkIn)
}

/** Two dates as a range: "1–4 Jun 2027", "1 May – 31 Jul 2027", "21 Oct 2026 – 13 Apr 2028" (each year it spans named). */
export function formatDateRange(from: string, to: string, locale: string): string {
  return dateFormatter(locale, 'medium').formatRange(utcDate(from), utcDate(to))
}

/** A stay as dates: "1–4 Jun 2027" (the check-out day is the end: the guests leave that morning). */
export function formatStay(checkIn: string, checkOut: string, locale: string): string {
  return formatDateRange(checkIn, checkOut, locale)
}

/** Money in halalas as Saudi riyals with the currency code and two decimals: "SAR 12,500.00". */
export function formatMoney(halalas: number, locale: string): string {
  return new Intl.NumberFormat(localeTag(locale), { style: 'currency', currency: 'SAR', currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(halalas / HALALAS_PER_RIYAL)
}

/** A count for people: grouped by thousands ("1,490"), Western digits in both languages. */
export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(localeTag(locale)).format(value)
}

/** A timestamp (ISO) in the hotel's time zone: "1 Jun 2027, 14:30". */
export function formatDateTime(isoTimestamp: string, locale: string, timeZone = 'Asia/Riyadh'): string {
  return new Intl.DateTimeFormat(localeTag(locale), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(isoTimestamp))
}
