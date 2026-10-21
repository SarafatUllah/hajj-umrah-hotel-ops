import { z } from 'zod'
import { BOOKING_TYPES } from '../constants/booking'
import { PRICE_UNITS, QUOTE_STATUSES } from '../constants/pricing'
import { halalas } from './bookingRules'
import { isoDate, pagination, safeText, uuid } from './common'
import { addStayDateIssues } from './stay'

export { MAX_STAY_NIGHTS } from './stay'

const counts = z.number().int().min(0).max(10_000)

/**
 * What an agency asks a price for (v7 §8): hotel, stay `[checkIn, checkOut)`, type and head count. GROUP gives men
 * and women (children counted on their side); FAMILY gives only the total.
 */
const quoteRequestFields = z.object({
  hotelId: uuid,
  bookingType: z.enum(BOOKING_TYPES),
  checkIn: isoDate,
  checkOut: isoDate,
  maleCount: counts.default(0),
  femaleCount: counts.default(0),
  totalCount: z.number().int().min(1).max(10_000),
  notes: safeText(1000).optional(),
}).strict()

function quoteRules(body: z.infer<typeof quoteRequestFields>, ctx: z.RefinementCtx): void {
  addStayDateIssues(body, ctx)
  if (body.bookingType === 'GROUP' && body.maleCount + body.femaleCount !== body.totalCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalCount'], message: 'For a group, men + women must equal the total' })
  }
  if (body.bookingType === 'FAMILY' && (body.maleCount !== 0 || body.femaleCount !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maleCount'], message: 'A family gives only the total' })
  }
}

/** `POST /api/agency/quotes` (agency portal). */
export const quoteRequestSchema = quoteRequestFields.superRefine(quoteRules)
export type QuoteRequestInput = z.infer<typeof quoteRequestSchema>

/** `POST /api/quotes` (staff, on an agency's behalf). */
export const staffQuoteCreateSchema = quoteRequestFields.extend({ agencyId: uuid }).strict().superRefine(quoteRules)
export type StaffQuoteCreateInput = z.infer<typeof staffQuoteCreateSchema>

/** `POST /api/quotes/:quoteId/offer` (staff after the WhatsApp talk): the price and how long it holds. */
export const quoteOfferSchema = z.object({
  amountHalalas: halalas,
  unit: z.enum(PRICE_UNITS),
  vatIncluded: z.boolean(),
  /** Defaults to the booking setting `quoteValidityHours` (48). */
  validHours: z.number().int().min(1).max(720).optional(),
}).strict()
export type QuoteOfferInput = z.infer<typeof quoteOfferSchema>

/** `POST /api/quotes/:quoteId/decline`. */
export const quoteDeclineSchema = z.object({ reason: safeText(500).refine(v => v.length >= 3, 'Give a reason') }).strict()
export type QuoteDeclineInput = z.infer<typeof quoteDeclineSchema>

/** `GET /api/quotes` (staff) and `GET /api/agency/quotes` (agency; `agencyId` ignored there). */
export const listQuotesQuerySchema = z.object({
  status: z.enum(QUOTE_STATUSES).optional(),
  hotelId: uuid.optional(),
  agencyId: uuid.optional(),
}).merge(pagination({ maxPageSize: 100 }))
export type ListQuotesQuery = z.infer<typeof listQuotesQuerySchema>
