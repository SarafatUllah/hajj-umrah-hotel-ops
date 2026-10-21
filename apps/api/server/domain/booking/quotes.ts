import type { BookingType } from '@hajj/contracts/constants/booking'
import type { QuoteStatus } from '@hajj/contracts/constants/pricing'
import { type IsoDate, toEpochDay } from '@hajj/contracts/utils/dates'

/** `Q-2027-0142`: year and a per-organization counter (v7 §8). */
export function quoteRefNo(year: number, sequence: number): string {
  return `Q-${year}-${String(sequence).padStart(4, '0')}`
}

/** What the status really is now: an OFFERED quote past its validity is EXPIRED even before the hourly sweep. */
export function effectiveQuoteStatus(quote: { status: QuoteStatus, validUntil: Date | null }, now: Date): QuoteStatus {
  return quote.status === 'OFFERED' && quote.validUntil !== null && quote.validUntil.getTime() <= now.getTime() ? 'EXPIRED' : quote.status
}

export interface QuoteMessageFacts {
  refNo: string
  agencyName: string
  hotelCode: string
  hotelName: string
  checkIn: IsoDate
  checkOut: IsoDate
  bookingType: BookingType
  maleCount: number
  femaleCount: number
  totalCount: number
}

/** The default WhatsApp message (v7 §8); an organization may set its own template with the same placeholders. */
export const DEFAULT_QUOTE_TEMPLATE = [
  'Assalamu alaikum. Price request: {ref}',
  'Agency: {agency}',
  'Hotel: {hotel} · {checkIn} – {checkOut} ({nights} nights)',
  'Type: {type} · {counts}',
].join('\n')

/** Fills `{ref}`, `{agency}`, `{hotel}`, `{checkIn}`, `{checkOut}`, `{nights}`, `{type}`, `{counts}`; unknown placeholders stay as written. */
export function quoteMessage(facts: QuoteMessageFacts, template: string = DEFAULT_QUOTE_TEMPLATE): string {
  const nights = toEpochDay(facts.checkOut) - toEpochDay(facts.checkIn)
  const counts = facts.bookingType === 'GROUP'
    ? `men ${facts.maleCount}, women ${facts.femaleCount} (total ${facts.totalCount})`
    : `${facts.totalCount} persons`
  const values: Record<string, string> = {
    ref: facts.refNo,
    agency: facts.agencyName,
    hotel: `${facts.hotelCode} ${facts.hotelName}`,
    checkIn: facts.checkIn,
    checkOut: facts.checkOut,
    nights: String(nights),
    type: facts.bookingType === 'GROUP' ? 'Group' : 'Family',
    counts,
  }
  // Own keys only: `{constructor}` or `{toString}` in a template must stay as written, never reach Object.prototype.
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key]! : whole))
}

/** Click-to-chat link (v7 §8: no WhatsApp API cost). `number` is digits only, with the country code. */
export function whatsappLink(number: string, text: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`
}
