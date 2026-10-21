/** Rate rows (v7 §8): the public price, and the optional default price for every approved agency. */
export const PRICE_TYPES = ['PUBLIC', 'AGENCY_DEFAULT'] as const
export type PriceType = typeof PRICE_TYPES[number]

/** What one amount buys: one person for one night (GROUP) or one room for one night (FAMILY). */
export const PRICE_UNITS = ['PER_PERSON_NIGHT', 'PER_ROOM_NIGHT'] as const
export type PriceUnit = typeof PRICE_UNITS[number]

/** WhatsApp quote lifecycle (v7 §8): REQUESTED → OFFERED → ACCEPTED (booked), or EXPIRED / DECLINED. */
export const QUOTE_STATUSES = ['REQUESTED', 'OFFERED', 'ACCEPTED', 'EXPIRED', 'DECLINED'] as const
export type QuoteStatus = typeof QUOTE_STATUSES[number]

/** A quote with a price: offered, or accepted by a booking. */
export const PRICED_QUOTE_STATUSES = ['OFFERED', 'ACCEPTED'] as const satisfies readonly QuoteStatus[]

/** Where a booking's frozen price came from (v7 §8: a valid quote, else the agency default, else the public price). */
export const PRICE_SOURCES = ['QUOTE', 'AGENCY_DEFAULT', 'PUBLIC'] as const
export type PriceSource = typeof PRICE_SOURCES[number]

/** One line of a booking's per-night price (v7 §16 booking_price_line). */
export const PRICE_LINE_KINDS = ['ROOM', 'PERSON', 'EXTRA_BED'] as const
export type PriceLineKind = typeof PRICE_LINE_KINDS[number]
