import type { BookingType } from '@hajj/contracts/constants/booking'
import type { PriceLineKind, PriceSource, PriceType, PriceUnit } from '@hajj/contracts/constants/pricing'
import { addDays, type IsoDate, toEpochDay } from '@hajj/contracts/utils/dates'

/** A rate row (v7 §8): public or agency default, per room type, unit and inclusive season. */
export interface RateRule {
  roomTypeId: string
  priceType: PriceType
  unit: PriceUnit
  startDate: IsoDate
  endDate: IsoDate
  amountHalalas: number
  vatIncluded: boolean
}

/** A quote's agreed price (applies to every room type and night of the stay). */
export interface QuoteTerms { amountHalalas: number, unit: PriceUnit, vatIncluded: boolean }

export interface ExtraBedPrice { roomTypeId: string, amountHalalas: number, vatIncluded: boolean }

export interface UnitPrice { source: PriceSource, amountHalalas: number, vatIncluded: boolean }

/** One room of an allocation: its type, the pilgrims seated in it (infants excluded) and its extra beds. */
export interface PricedRoom {
  roomTypeId: string
  seats: number
  extraBeds: number
  /** The booking already pays for this room (pilgrims added to it): per room it is not charged again. */
  alreadyPaid?: boolean
}

export interface PriceLine {
  night: IsoDate
  kind: PriceLineKind
  roomTypeId: string | null
  quantity: number
  unitAmountHalalas: number
  amountHalalas: number
  vatIncluded: boolean
}

export interface PricedStay { lines: PriceLine[], totalHalalas: number, source: PriceSource }
export interface UnpricedStay { missing: Array<{ night: IsoDate, roomTypeId: string, kind: 'RATE' | 'EXTRA_BED' }> }

/** §23 Q3: GROUP is priced per person per night, FAMILY per room per night (a quote may say otherwise). */
export function defaultUnitFor(bookingType: BookingType): PriceUnit {
  return bookingType === 'GROUP' ? 'PER_PERSON_NIGHT' : 'PER_ROOM_NIGHT'
}

/**
 * The price of one unit on one night (v7 §8): a valid quote; otherwise, for an agency, the agency default rate;
 * otherwise the public rate. `null` = no price for that room type and night (the stay cannot be priced).
 */
export function unitPriceFor(args: { night: IsoDate, roomTypeId: string, unit: PriceUnit, rates: readonly RateRule[], quote: QuoteTerms | null, agencyDefault: boolean }): UnitPrice | null {
  if (args.quote) return { source: 'QUOTE', amountHalalas: args.quote.amountHalalas, vatIncluded: args.quote.vatIncluded }
  const rateOf = (type: PriceType) => args.rates.find(r => r.priceType === type && r.unit === args.unit && r.roomTypeId === args.roomTypeId && r.startDate <= args.night && args.night <= r.endDate)
  const chosen = (args.agencyDefault ? rateOf('AGENCY_DEFAULT') : undefined) ?? rateOf('PUBLIC')
  if (!chosen) return null
  return { source: chosen.priceType === 'AGENCY_DEFAULT' ? 'AGENCY_DEFAULT' : 'PUBLIC', amountHalalas: chosen.amountHalalas, vatIncluded: chosen.vatIncluded }
}

/**
 * The frozen per-night price lines of a stay `[checkIn, checkOut)` over the allocated rooms (v7 §8, §16): per
 * person — the seated pilgrims of each room type × the unit price (empty seats are never charged); per room — the
 * rooms of each type; extra beds — per room type at the policy's price. The unit is the quote's when there is one,
 * else `unit` (the booking type's default). The booking's source is QUOTE, else
 * AGENCY_DEFAULT if any night used it, else PUBLIC. Any night without a price makes the whole stay unpriced.
 */
export function priceStay(args: {
  checkIn: IsoDate
  checkOut: IsoDate
  rooms: readonly PricedRoom[]
  unit: PriceUnit
  rates: readonly RateRule[]
  quote: QuoteTerms | null
  agencyDefault: boolean
  extraBedPrices: readonly ExtraBedPrice[]
}): PricedStay | UnpricedStay {
  const byType = new Map<string, { seats: number, rooms: number, extraBeds: number }>()
  for (const room of args.rooms) {
    const t = byType.get(room.roomTypeId) ?? { seats: 0, rooms: 0, extraBeds: 0 }
    byType.set(room.roomTypeId, { seats: t.seats + room.seats, rooms: t.rooms + (room.alreadyPaid ? 0 : 1), extraBeds: t.extraBeds + room.extraBeds })
  }
  const lines: PriceLine[] = []
  const missing: UnpricedStay['missing'] = []
  const sources = new Set<PriceSource>()
  // A quote's own unit wins over the booking type's default (a FAMILY quoted per person is charged per person).
  const unit = args.quote?.unit ?? args.unit
  const kind: PriceLineKind = unit === 'PER_PERSON_NIGHT' ? 'PERSON' : 'ROOM'
  const nights = toEpochDay(args.checkOut) - toEpochDay(args.checkIn)

  for (let i = 0; i < nights; i++) {
    const night = addDays(args.checkIn, i)
    for (const [roomTypeId, totals] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const quantity = kind === 'PERSON' ? totals.seats : totals.rooms
      const price = quantity > 0 ? unitPriceFor({ night, roomTypeId, unit, rates: args.rates, quote: args.quote, agencyDefault: args.agencyDefault }) : null
      // Nothing to charge (e.g. only infants in these rooms): no price is needed.
      if (quantity > 0 && !price) missing.push({ night, roomTypeId, kind: 'RATE' })
      else if (price) {
        sources.add(price.source)
        lines.push({ night, kind, roomTypeId, quantity, unitAmountHalalas: price.amountHalalas, amountHalalas: quantity * price.amountHalalas, vatIncluded: price.vatIncluded })
      }
      if (totals.extraBeds > 0) {
        const bed = args.extraBedPrices.find(p => p.roomTypeId === roomTypeId)
        if (!bed) missing.push({ night, roomTypeId, kind: 'EXTRA_BED' })
        else lines.push({ night, kind: 'EXTRA_BED', roomTypeId, quantity: totals.extraBeds, unitAmountHalalas: bed.amountHalalas, amountHalalas: totals.extraBeds * bed.amountHalalas, vatIncluded: bed.vatIncluded })
      }
    }
  }
  if (missing.length > 0) return { missing }
  const source: PriceSource = sources.has('QUOTE') ? 'QUOTE' : sources.has('AGENCY_DEFAULT') ? 'AGENCY_DEFAULT' : 'PUBLIC'
  return { lines, totalHalalas: lines.reduce((sum, line) => sum + line.amountHalalas, 0), source }
}

export const isUnpriced = (stay: PricedStay | UnpricedStay): stay is UnpricedStay => 'missing' in stay

/** The highest PUBLIC rate of `unit` on any night of `[checkIn, checkOut)` (any room type), or null: the quote warning (v7 §8). */
export function highestPublicRate(rates: readonly RateRule[], unit: PriceUnit, checkIn: IsoDate, checkOut: IsoDate): number | null {
  const lastNight = addDays(checkOut, -1)
  const amounts = rates.filter(r => r.priceType === 'PUBLIC' && r.unit === unit && r.startDate <= lastNight && checkIn <= r.endDate).map(r => r.amountHalalas)
  return amounts.length > 0 ? Math.max(...amounts) : null
}
