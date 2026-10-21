import { type DateStyle, formatDate, formatDateTime, formatMoney, formatStay, nightsBetween } from '../utils/format'

/** The formatters bound to the current language. */
export function useFormat() {
  const { locale } = useI18n()
  return {
    date: (isoDate: string, style?: DateStyle) => formatDate(isoDate, locale.value, style),
    dateTime: (isoTimestamp: string, timeZone?: string) => formatDateTime(isoTimestamp, locale.value, timeZone),
    stay: (checkIn: string, checkOut: string) => formatStay(checkIn, checkOut, locale.value),
    money: (halalas: number) => formatMoney(halalas, locale.value),
    nights: nightsBetween,
  }
}
