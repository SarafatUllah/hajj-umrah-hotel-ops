import type { Occupancy } from '@hajj/contracts/constants/booking'
import type { CustomerRequestInput, CustomerStaySearchInput, ListBookingsQuery } from '@hajj/contracts/schemas/booking'
import { ageGroupFor } from '../../domain/booking/guestRules'
import { rethrowDbError } from '../../errors/dbErrors'
import { ValidationError } from '../../errors/domainError'
import { bookingOrgRepos } from '../../repositories'
import type { GuestSlotRow } from '../../repositories/booking'
import type { CustomerContext } from '../../security/customerContext'
import { consumeRateLimit, RATE_LIMITS } from '../../security/rateLimit'
import { loadForCustomer } from './bookingAccess'
import { type BookingDetailDto, bookingDetail, type BookingPage, receiptOf, type ReceiptDto, toPage } from './bookingService'
import { loadBookingSettings } from './bookingSettingsService'
import { assertGuestFits, customerWriter, saveSlot } from './guestService'
import { placeHold, searchStay } from './holdService'
import type { Booker } from './stayFacts'
import type { StaySearchResult } from './stayChecks'

const customerBooker = (ctx: CustomerContext): Booker => ({ kind: 'INDIVIDUAL', customerId: ctx.scope.customerId })

/** Public site (v7 §6, §9): the options for the customer's stay at the public price (rooms of their own only). */
export async function searchCustomerStay(ctx: CustomerContext, input: CustomerStaySearchInput): Promise<StaySearchResult> {
  await consumeRateLimit(ctx.db, RATE_LIMITS.staySearchPerCustomer, ctx.scope.customerId, ctx.now())
  return searchStay(ctx.db, ctx.scope, customerBooker(ctx), input, ctx.now())
}

/** The slot the lead pilgrim's passport fills: the first adult of their side (a family's first adult). */
function leadSlotOf(slots: readonly GuestSlotRow[], bookingType: string, gender: string): GuestSlotRow | undefined {
  return slots.find(s => s.guest.ageGroup === 'ADULT' && (bookingType === 'FAMILY' || s.guest.gender === gender))
}

/**
 * Public site (v7 §6, §10): the customer requests the chosen option — REQUESTED for the request hours, until the
 * hotel confirms (at most `individualMaxOpenRequests` open at a time) — with the lead pilgrim's passport, which fills
 * the first adult slot of their side. The lead is an adult on the check-in day (422 `LEAD_NOT_ADULT`, before anything
 * is locked: v7's "at least the father's passport"). The request and the passport are one transaction: no request
 * without it (422 `LEAD_DOES_NOT_FIT` when the booking has no adult slot of the lead's side; the passport's own checks
 * as for any pilgrim's details).
 */
export async function requestCustomerStay(ctx: CustomerContext, input: CustomerRequestInput): Promise<BookingDetailDto> {
  const now = ctx.now()
  const { lead, ...stay } = input
  // The lead's passport is checked before any lock is taken or any attempt counted (the transaction checks it again).
  const settings = await loadBookingSettings(ctx.db, ctx.scope)
  if (ageGroupFor(lead.dateOfBirth!, stay.checkIn, settings) !== 'ADULT') throw new ValidationError('LEAD_NOT_ADULT', 'The lead pilgrim must be an adult on the check-in day')
  const side = stay.bookingType === 'FAMILY' ? 'FAMILY' : lead.gender as Occupancy
  assertGuestFits({ bookingType: stay.bookingType, ageGroup: 'ADULT', occupancy: side, checkIn: stay.checkIn }, lead, settings)
  await consumeRateLimit(ctx.db, RATE_LIMITS.requestPerCustomer, ctx.scope.customerId, now)
  const requested = await ctx.db.transaction(async (tx) => {
    const held = await placeHold(tx, ctx.scope, customerBooker(ctx), stay, now)
    const repos = bookingOrgRepos(tx, ctx.scope)
    const row = (await repos.records.findById(held.id))!
    const slot = leadSlotOf(await repos.guests.listForBooking(row.id), row.bookingType, lead.gender!)
    if (!slot) throw new ValidationError('LEAD_DOES_NOT_FIT', 'The lead pilgrim needs an adult place on their side of this booking')
    await saveSlot(tx, ctx.scope, row, slot.guest.id, lead, customerWriter(ctx))
    return row
  }).catch(rethrowDbError)
  return bookingDetail(ctx.db, ctx.scope, requested, now)
}

/** Public site: the customer's own bookings, newest first. */
export async function listCustomerBookings(ctx: CustomerContext, query: ListBookingsQuery): Promise<BookingPage> {
  const now = ctx.now()
  return toPage(await bookingOrgRepos(ctx.db, ctx.scope).records.list({ ...query, agencyId: undefined, customerId: ctx.scope.customerId, now }), query, now)
}

/** Public site: one of the customer's own bookings (anyone else's is 404). */
export async function getCustomerBooking(ctx: CustomerContext, bookingId: string): Promise<BookingDetailDto> {
  return bookingDetail(ctx.db, ctx.scope, await loadForCustomer(ctx, bookingId), ctx.now())
}

/** The receipt with its QR once the hotel confirmed the request (409 `NOT_CONFIRMED` before). */
export async function customerBookingReceipt(ctx: CustomerContext, bookingId: string): Promise<ReceiptDto> {
  return receiptOf(ctx.db, ctx.scope, await loadForCustomer(ctx, bookingId))
}
