import type { PriceUnit, QuoteStatus } from '@hajj/contracts/constants/pricing'
import type { ListQuotesQuery, QuoteDeclineInput, QuoteOfferInput, QuoteRequestInput, StaffQuoteCreateInput } from '@hajj/contracts/schemas/quote'
import { todayInTimezone } from '@hajj/contracts/utils/dates'
import { highestPublicRate } from '../../domain/booking/pricing'
import { toRateRule } from './pricingRows'
import { effectiveQuoteStatus, quoteMessage, quoteRefNo, whatsappLink } from '../../domain/booking/quotes'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, bookingRepos, tenantRepos } from '../../repositories'
import type { PriceQuoteRow } from '../../repositories/booking'
import type { HotelRow } from '../../repositories/tenant'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import { authorizeHotel, requireOrgPermission } from '../../security/authorize'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import type { OrganizationScope } from '../../security/scope'
import { findAgencyBrief } from '../accounts'
import { recordAudit } from '../audit'
import { loadBookingSettings } from './bookingSettingsService'
import { sweepOrganizations } from './sweep'

/** The database handle a repository accepts (a service may not import db/client itself). */
type Db = Parameters<typeof bookingOrgRepos>[0]

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

export interface RequestedQuote { quote: QuoteDto, whatsappLink: string | null }
export interface OfferedQuote { quote: QuoteDto, aboveHighestPublicRate: boolean }
export interface QuotePage { items: QuoteDto[], total: number, page: number, pageSize: number }

function toQuoteDto(row: PriceQuoteRow, now: Date): QuoteDto {
  return {
    id: row.id,
    refNo: row.refNo,
    agencyId: row.agencyId,
    hotelId: row.hotelId,
    bookingType: row.bookingType,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    maleCount: row.maleCount,
    femaleCount: row.femaleCount,
    totalCount: row.totalCount,
    status: effectiveQuoteStatus({ status: row.status as QuoteStatus, validUntil: row.validUntil }, now),
    amountHalalas: row.amountHalalas,
    unit: row.unit as PriceUnit | null,
    vatIncluded: row.vatIncluded,
    validUntil: row.validUntil?.toISOString() ?? null,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  }
}

async function activeHotel(db: Db, scope: OrganizationScope, hotelId: string): Promise<HotelRow> {
  const hotel = await tenantRepos(db, scope).hotels.findById(hotelId)
  if (!hotel || hotel.status !== 'ACTIVE') throw new ValidationError('INVALID_REFERENCE', 'hotelId does not reference an active hotel')
  return hotel
}

/**
 * Creates a REQUESTED quote with the next `Q-<year>-<n>` reference (one transaction: the counter row lock
 * serializes concurrent requests) and builds the WhatsApp click-to-chat link from the organization's number and
 * template (null while no number is configured). Audited (actor: the staff user, or none for an agency request).
 */
async function createQuote(db: Db, scope: OrganizationScope, input: QuoteRequestInput & { agencyId: string }, actor: { userId: string | null, agencyUserId: string | null }, now: Date): Promise<RequestedQuote> {
  const hotel = await activeHotel(db, scope, input.hotelId)
  const agency = await findAgencyBrief(db, scope, input.agencyId)
  if (!agency || agency.status !== 'APPROVED') throw new ValidationError('AGENCY_NOT_APPROVED', 'Quotes are for approved agencies only')
  const settings = await loadBookingSettings(db, scope)

  const row = await db.transaction(async (tx) => {
    const repos = bookingOrgRepos(tx, scope)
    // The year as the hotel sees it (a request just after midnight on 1 January in Makkah is next year's).
    const year = Number(todayInTimezone(hotel.timezone, now).slice(0, 4))
    const created = await repos.quotes.insert({
      refNo: quoteRefNo(year, await repos.sequences.next('QUOTE', year)),
      agencyId: agency.id,
      hotelId: hotel.id,
      bookingType: input.bookingType,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      maleCount: input.maleCount,
      femaleCount: input.femaleCount,
      totalCount: input.totalCount,
      notes: input.notes ?? null,
      requestedByUserId: actor.userId,
      requestedByAgencyUserId: actor.agencyUserId,
    })
    await recordAudit(tenantRepos(tx, scope).audit, actor.userId, { hotelId: hotel.id, entityType: 'price_quote', entityId: created.id, action: 'QUOTE_REQUESTED', after: { refNo: created.refNo, agencyId: agency.id, requestedByAgencyUserId: actor.agencyUserId } })
    return created
  })

  const message = quoteMessage({ refNo: row.refNo, agencyName: agency.name, hotelCode: hotel.code, hotelName: hotel.name, checkIn: row.checkIn, checkOut: row.checkOut, bookingType: input.bookingType, maleCount: row.maleCount, femaleCount: row.femaleCount, totalCount: row.totalCount }, settings.whatsappTemplate ?? undefined)
  return { quote: toQuoteDto(row, now), whatsappLink: settings.whatsappNumber ? whatsappLink(settings.whatsappNumber, message) : null }
}

/** Agency portal: "ask the price on WhatsApp" (v7 §8). The route already requires an approved agency; requests are rate limited per agency. */
export async function requestQuote(ctx: AgencyContext, input: QuoteRequestInput): Promise<RequestedQuote> {
  await consumeRateLimit(ctx.db, RATE_LIMITS.quoteRequestPerAgency, ctx.scope.agencyId, ctx.now())
  return createQuote(ctx.db, ctx.scope, { ...input, agencyId: ctx.scope.agencyId }, { userId: null, agencyUserId: ctx.identity.agencyUserId }, ctx.now())
}

/** Staff open a quote for an agency (e.g. the WhatsApp talk started elsewhere); needs `quote.manage` on the hotel. */
export async function createQuoteForAgency(ctx: AuthContext, input: StaffQuoteCreateInput): Promise<RequestedQuote> {
  await authorizeHotel(ctx, 'quote.manage', input.hotelId)
  return createQuote(ctx.db, ctx.scope, input, { userId: ctx.identity.userId, agencyUserId: null }, ctx.now())
}

export async function listAgencyQuotes(ctx: AgencyContext, query: ListQuotesQuery): Promise<QuotePage> {
  const { rows, total } = await bookingOrgRepos(ctx.db, ctx.scope).quotes.list({ ...query, agencyId: ctx.scope.agencyId })
  return { items: rows.map(r => toQuoteDto(r, ctx.now())), total, page: query.page, pageSize: query.pageSize }
}

/** An agency sees only its own quotes; another agency's quote is "not found". */
export async function getAgencyQuote(ctx: AgencyContext, quoteId: string): Promise<QuoteDto> {
  const row = await bookingOrgRepos(ctx.db, ctx.scope).quotes.findById(quoteId)
  if (!row || row.agencyId !== ctx.scope.agencyId) throw new NotFoundError('QUOTE_NOT_FOUND')
  return toQuoteDto(row, ctx.now())
}

/** Staff list (`booking.view`): only quotes of hotels the caller can access. */
export async function listQuotes(ctx: AuthContext, query: ListQuotesQuery): Promise<QuotePage> {
  requireOrgPermission(ctx, 'booking.view')
  const hotelIds = ctx.authz.allHotels ? undefined : [...ctx.authz.hotelIds]
  const { rows, total } = await bookingOrgRepos(ctx.db, ctx.scope).quotes.list({ ...query, hotelIds })
  return { items: rows.map(r => toQuoteDto(r, ctx.now())), total, page: query.page, pageSize: query.pageSize }
}

/**
 * A quote of a hotel the caller cannot access is "not found" (the hotel's 404 rule). Reading works for an inactive
 * hotel; offering or declining (`quote.manage`) does not (409 `HOTEL_INACTIVE`, like every Phase 1 write).
 */
async function loadQuoteForStaff(ctx: AuthContext, db: Db, quoteId: string, permission: 'booking.view' | 'quote.manage', forUpdate = false) {
  const row = await bookingOrgRepos(db, ctx.scope).quotes.findById(quoteId, { forUpdate })
  if (!row) throw new NotFoundError('QUOTE_NOT_FOUND')
  const access = await authorizeHotel(ctx, permission, row.hotelId, { allowInactive: permission === 'booking.view' }).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new NotFoundError('QUOTE_NOT_FOUND')
    throw error
  })
  return { row, hotel: access.hotel, scope: access.scope }
}

export async function getQuote(ctx: AuthContext, quoteId: string): Promise<QuoteDto> {
  return toQuoteDto((await loadQuoteForStaff(ctx, ctx.db, quoteId, 'booking.view')).row, ctx.now())
}

/**
 * Staff set the agreed price after the WhatsApp talk (v7 §8): REQUESTED (or re-offering an OFFERED quote, e.g.
 * a new price or validity) → OFFERED, valid `validHours` (default: the booking setting, 48 h). The answer says
 * whether the price is above the highest public rate for the stay (a warning to the seller, not a refusal). A
 * quote never holds rooms. Audited.
 */
export async function offerQuote(ctx: AuthContext, quoteId: string, input: QuoteOfferInput): Promise<OfferedQuote> {
  const now = ctx.now()
  const settings = await loadBookingSettings(ctx.db, ctx.scope)
  return ctx.db.transaction(async (tx) => {
    const { row, hotel, scope } = await loadQuoteForStaff(ctx, tx, quoteId, 'quote.manage', true)
    const status = effectiveQuoteStatus({ status: row.status as QuoteStatus, validUntil: row.validUntil }, now)
    if (status !== 'REQUESTED' && status !== 'OFFERED') throw new ConflictError('QUOTE_NOT_OPEN', `A quote that is ${status} cannot be offered`)

    const validUntil = new Date(now.getTime() + (input.validHours ?? settings.quoteValidityHours) * 3600_000)
    const updated = (await bookingOrgRepos(tx, ctx.scope).quotes.setOffer(row.id, { amountHalalas: input.amountHalalas, unit: input.unit, vatIncluded: input.vatIncluded, validUntil, offeredBy: ctx.identity.userId, offeredAt: now }))!
    const rates = (await bookingRepos(tx, scope).rates.list()).map(toRateRule)
    const highest = highestPublicRate(rates, input.unit, row.checkIn, row.checkOut)
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { hotelId: hotel.id, entityType: 'price_quote', entityId: row.id, action: 'QUOTE_OFFERED', before: { status: row.status, amountHalalas: row.amountHalalas }, after: { status: 'OFFERED', amountHalalas: input.amountHalalas, unit: input.unit, validUntil: validUntil.toISOString() } })
    return { quote: toQuoteDto(updated, now), aboveHighestPublicRate: highest !== null && input.amountHalalas > highest }
  })
}

/** Staff decline a REQUESTED or OFFERED quote, with a reason (kept in the audit, not shown to the agency). */
export async function declineQuote(ctx: AuthContext, quoteId: string, input: QuoteDeclineInput): Promise<QuoteDto> {
  const now = ctx.now()
  return ctx.db.transaction(async (tx) => {
    const { row, hotel } = await loadQuoteForStaff(ctx, tx, quoteId, 'quote.manage', true)
    const status = effectiveQuoteStatus({ status: row.status as QuoteStatus, validUntil: row.validUntil }, now)
    if (status !== 'REQUESTED' && status !== 'OFFERED') throw new ConflictError('QUOTE_NOT_OPEN', `A quote that is ${status} cannot be declined`)
    const updated = (await bookingOrgRepos(tx, ctx.scope).quotes.setStatus(row.id, 'DECLINED', now))!
    await recordAudit(tenantRepos(tx, ctx.scope).audit, ctx.identity.userId, { hotelId: hotel.id, entityType: 'price_quote', entityId: row.id, action: 'QUOTE_DECLINED', before: { status: row.status }, after: { status: 'DECLINED' }, reason: input.reason })
    return toQuoteDto(updated, now)
  })
}

/**
 * The hourly sweep (job `booking.quote-expiry`): every organization's OFFERED quotes past validity become EXPIRED.
 * One organization's failure is logged and does not stop the others; the job then fails (pg-boss retries it).
 */
export async function expireOfferedQuotes(db: Db, organizationScopes: readonly OrganizationScope[], now: Date): Promise<number> {
  return sweepOrganizations('quotes', organizationScopes, scope => bookingOrgRepos(db, scope).quotes.expireOffered(now))
}
