/** The quote API's response shapes (v7 §8: a price for exactly one hotel, stay, type and head count). */
import type { PriceUnit, QuoteStatus } from '../constants/pricing'

export interface QuoteDto {
  id: string
  refNo: string
  agencyId: string
  hotelId: string
  bookingType: string
  checkIn: string
  checkOut: string
  maleCount: number
  femaleCount: number
  totalCount: number
  /** Effective status: an OFFERED quote past its validity reads EXPIRED. */
  status: QuoteStatus
  amountHalalas: number | null
  unit: PriceUnit | null
  vatIncluded: boolean | null
  validUntil: string | null
  notes: string | null
  createdAt: string
}

/** A quote request just sent, with the click-to-chat link of the hotel's WhatsApp (null when none is set). */
export interface RequestedQuote { quote: QuoteDto, whatsappLink: string | null }
export interface OfferedQuote { quote: QuoteDto, aboveHighestPublicRate: boolean }
export interface QuotePage { items: QuoteDto[], total: number, page: number, pageSize: number }
