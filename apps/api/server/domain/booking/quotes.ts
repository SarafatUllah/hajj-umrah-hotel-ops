import type { BookingType } from '@hajj/contracts/constants/booking'
import type { QuoteStatus } from '@hajj/contracts/constants/pricing'
import { type IsoDate, toEpochDay } from '@hajj/contracts/utils/dates'
import { stayNeeds, type StayHeadcount } from './allocation/planner'
import { documentNo } from './references'

/** `Q-2027-0142`: year and a per-organization counter (v7 §8). */
export const quoteRefNo = (year: number, sequence: number): string => documentNo('QUOTE', year, sequence)

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

/** What a quote was asked for. GROUP quotes count children on their parent's side. */
export interface QuotedStay { hotelId: string, bookingType: BookingType, checkIn: IsoDate, checkOut: IsoDate, maleCount: number, femaleCount: number, totalCount: number }

/**
 * v7 §8: a quote serves only a booking of its hotel, dates, type and head count — for a GROUP, each side as
 * quoted (children on the side they sleep on), for a FAMILY the total.
 */
export function quoteFitsStay(quote: QuotedStay, stay: StayHeadcount & { hotelId: string, checkIn: IsoDate, checkOut: IsoDate }): boolean {
  if (quote.hotelId !== stay.hotelId || quote.bookingType !== stay.bookingType || quote.checkIn !== stay.checkIn || quote.checkOut !== stay.checkOut) return false
  if (quote.totalCount !== stay.totalCount) return false
  if (stay.bookingType === 'FAMILY') return true
  const sides = new Map(stayNeeds(stay).map(s => [s.occupancy, s.need]))
  return (sides.get('MALE') ?? 0) === quote.maleCount && (sides.get('FEMALE') ?? 0) === quote.femaleCount
}
