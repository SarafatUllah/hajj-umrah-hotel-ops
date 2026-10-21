import type { BookingType } from '@hajj/contracts/constants/booking'
import type { PriceSource, PriceUnit, QuoteStatus } from '@hajj/contracts/constants/pricing'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { HoldRequestInput, StaySearchInput } from '@hajj/contracts/schemas/booking'
import { todayInTimezone } from '@hajj/contracts/utils/dates'
import { planStay, type StayHeadcount } from '../../domain/booking/allocation/planner'
import { checkStayPlan, type ChosenRoom } from '../../domain/booking/allocation/stayPlanCheck'
import { stayNights } from '../../domain/booking/allocation/stayRooms'
import { guestSlots } from '../../domain/booking/guestSlots'
import { isUnpriced, type QuoteTerms } from '../../domain/booking/pricing'
import { effectiveQuoteStatus, quoteFitsStay } from '../../domain/booking/quotes'
import { documentNo } from '../../domain/booking/references'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, bookingRepos } from '../../repositories'
import { bookableHotel } from '../../security/authorize'
import type { OrganizationScope } from '../../security/scope'
import { loadBookingSettings } from './bookingSettingsService'
import { agencyOwnerKey, type Booker, headcountOf, loadStayFacts } from './stayFacts'
import { assertApprovedAgency, assertQuota, checkInput, optionError, priceRooms, quotaHeadroomFor, type StaySearchResult, toOption } from './stayChecks'
import { sweepOrganizations } from './sweep'

type Db = Parameters<typeof bookingRepos>[0]

export interface HeldBooking {
  id: string
  bookingNo: string
  status: string
  holdExpiresAt: string
  checkIn: string
  checkOut: string
  totalHalalas: number
  priceSource: PriceSource
  rooms: ChosenRoom[]
}

/**
 * The agency's offered quote to book at (v7 §8): its own, still OFFERED (not past validity), for exactly this
 * hotel, dates, type and head count. A quote serves one live booking (`booking_quote_once`).
 */
async function usableQuote(db: Db, scope: OrganizationScope, booker: Booker, input: StaySearchInput, headcount: StayHeadcount, now: Date): Promise<{ id: string, terms: QuoteTerms } | null> {
  if (!input.quoteId) return null
  if (booker.kind !== 'AGENCY') throw new ValidationError('QUOTE_NOT_USABLE', 'Quotes are for agencies')
  const row = await bookingOrgRepos(db, scope).quotes.findById(input.quoteId)
  if (!row || row.agencyId !== booker.agencyId) throw new NotFoundError('QUOTE_NOT_FOUND')
  if (effectiveQuoteStatus({ status: row.status as QuoteStatus, validUntil: row.validUntil }, now) !== 'OFFERED') throw new ConflictError('QUOTE_NOT_OPEN', 'This quote is no longer open')
  if (!quoteFitsStay({ ...row, bookingType: row.bookingType as BookingType }, { ...headcount, hotelId: input.hotelId, checkIn: input.checkIn, checkOut: input.checkOut })) {
    throw new ValidationError('QUOTE_MISMATCH', 'The booking must match the quote\'s hotel, dates, type and head count')
  }
  return { id: row.id, terms: { amountHalalas: row.amountHalalas!, unit: row.unit as PriceUnit, vatIncluded: row.vatIncluded! } }
}

/**
 * v7 §9: the two or three best complete options for a stay, priced (nothing is locked or saved). An agency's
 * request beyond its quota fails at once with the number still possible (422 `QUOTA_EXCEEDED`).
 */
export async function searchStay(db: Db, scope: OrganizationScope, booker: Booker, input: StaySearchInput, now: Date): Promise<StaySearchResult> {
  const { scope: hotelScope } = await bookableHotel(db, scope, input.hotelId)
  await assertApprovedAgency(db, scope, booker)
  const settings = await loadBookingSettings(db, scope)
  const headcount = headcountOf(input, settings)
  const quote = await usableQuote(db, scope, booker, input, headcount, now)
  const headroom = booker.kind === 'AGENCY'
    ? await quotaHeadroomFor(db, hotelScope, booker.agencyId, input, await bookingRepos(db, hotelScope).inventory.agencyPersonsByNight(booker.agencyId, stayNights(input)))
    : null
  assertQuota(headroom, input.totalCount)
  const facts = await loadStayFacts({ db, hotelScope, booker, input, headcount, settings, quote: quote?.terms ?? null })
  return { options: planStay(facts.planner).flatMap(plan => toOption(plan, facts, input)), quotaHeadroom: headroom }
}

function actorOf(booker: Booker): { kind: ActorKind, id: string | null } {
  if (booker.kind === 'INDIVIDUAL') return { kind: 'customer', id: booker.customerId }
  return booker.staffUserId ? { kind: 'staff', id: booker.staffUserId } : { kind: 'agency', id: booker.agencyUserId }
}

/**
 * v7 §9.2 step 7 and §10 — holds the chosen option in ONE transaction, always in the same lock order:
 * 1. the agency's quota lock, then the persons it already holds (agency bookings); or the customer's request lock,
 *    then its open requests, at most `individualMaxOpenRequests` (individual bookings);
 * 2. the rooms, `ORDER BY id FOR UPDATE`;
 * 3. pending bookings on those rooms whose hold lapsed become EXPIRED;
 * 4. everything is checked again on fresh reads: the quota, every room for every night (inventory, blocks,
 *    seats, owner, gender), the option's rules, the price;
 * 5. the booking is saved HELD (agency, `holdMinutes`) or REQUESTED (individual, `requestHours`), with its room
 *    claims, pilgrim slots and stays, frozen price lines and the CREATED change.
 * A room taken in the meantime is 409 `OPTION_UNAVAILABLE` (search again); a request that does not fit the rules
 * is 422 `INVALID_OPTION`. The booking number is `B-<hotel's year>-<n>`.
 */
export async function placeHold(db: Db, scope: OrganizationScope, booker: Booker, input: HoldRequestInput, now: Date): Promise<HeldBooking> {
  const { hotel, scope: hotelScope } = await bookableHotel(db, scope, input.hotelId)
  await assertApprovedAgency(db, scope, booker)
  const settings = await loadBookingSettings(db, scope)
  const headcount = headcountOf(input, settings)
  const roomIds = [...new Set(input.rooms.map(r => r.roomId))]
  const year = Number(todayInTimezone(hotel.timezone, now).slice(0, 4))

  return db.transaction(async (tx) => {
    const repos = bookingRepos(tx, hotelScope)
    const nights = stayNights(input)
    const held = booker.kind === 'AGENCY' ? await repos.inventory.lockAgencyQuota(booker.agencyId, nights) : null
    if (booker.kind === 'INDIVIDUAL') {
      const open = await bookingOrgRepos(tx, scope).records.lockOpenRequests(booker.customerId, now)
      if (open >= settings.individualMaxOpenRequests) throw new ConflictError('TOO_MANY_OPEN_REQUESTS', `At most ${settings.individualMaxOpenRequests} open request(s) at a time; wait for the hotel's answer`)
    }
    const locked = await repos.inventory.lockRooms(roomIds)
    if (locked.length !== roomIds.length) throw optionError(roomIds.filter(id => !locked.includes(id)).map(roomId => ({ code: 'ROOM_UNKNOWN', roomId })))
    await repos.bookings.expireLapsedHolds(locked, now)

    // Read after the locks: the quote as it is now, the quota, and the agency's own rooms for "own room first".
    const quote = await usableQuote(tx, scope, booker, input, headcount, now)
    if (booker.kind === 'AGENCY') assertQuota(await quotaHeadroomFor(tx, hotelScope, booker.agencyId, input, held!), input.totalCount)
    const ownRoomIds = booker.kind === 'AGENCY' && input.bookingType === 'GROUP'
      ? (await repos.inventory.liveClaims(null, nights.from, nights.to)).filter(c => c.ownerKey === agencyOwnerKey(booker.agencyId)).map(c => c.roomId)
      : []
    const facts = await loadStayFacts({ db: tx, hotelScope, booker, input, headcount, settings, quote: quote?.terms ?? null, roomIds: [...new Set([...locked, ...ownRoomIds])] })
    const problems = checkStayPlan(checkInput(facts, input.rooms), input.rooms)
    if (problems.length > 0) throw optionError(problems)
    const priced = priceRooms(facts, input, input.rooms)
    if (isUnpriced(priced)) throw new ValidationError('STAY_UNPRICED', 'Some nights of this stay have no price', { missing: priced.missing })

    const pending = booker.kind === 'AGENCY' ? { status: 'HELD', ms: settings.holdMinutes * 60_000 } : { status: 'REQUESTED', ms: settings.requestHours * 3_600_000 }
    const row = await repos.bookings.insertHold({
      booking: {
        bookingNo: documentNo('BOOKING', year, await bookingOrgRepos(tx, scope).sequences.next('BOOKING', year)),
        bookerType: booker.kind,
        agencyId: booker.kind === 'AGENCY' ? booker.agencyId : null,
        customerId: booker.kind === 'INDIVIDUAL' ? booker.customerId : null,
        createdByUserId: booker.kind === 'AGENCY' ? booker.staffUserId : null,
        createdByAgencyUserId: booker.kind === 'AGENCY' ? booker.agencyUserId : null,
        bookingType: input.bookingType,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        maleCount: input.maleCount,
        femaleCount: input.femaleCount,
        childCount: input.childCount,
        infantCount: input.infantCount,
        totalCount: input.totalCount,
        childSide: headcount.childSide,
        priceSource: priced.source,
        quoteId: quote?.id ?? null,
        status: pending.status,
        holdExpiresAt: new Date(now.getTime() + pending.ms),
        notes: input.notes ?? null,
      },
      rooms: input.rooms.map(r => ({ roomId: r.roomId, occupancy: r.occupancy, extraBeds: r.extraBeds, ownedByAgency: booker.kind === 'AGENCY' && input.bookingType === 'GROUP' })),
      guests: guestSlots({ ...headcount, infantCount: input.infantCount }, input.rooms),
      priceLines: priced.lines,
      actor: actorOf(booker),
    })

    return {
      id: row.id,
      bookingNo: row.bookingNo,
      status: row.status,
      holdExpiresAt: row.holdExpiresAt!.toISOString(),
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      totalHalalas: priced.totalHalalas,
      priceSource: priced.source,
      rooms: input.rooms,
    }
  // Constraint errors, at a statement or at COMMIT (the deferred containment checks), become their friendly 409s.
  }).catch(rethrowDbError)
}

/** The minute sweep (job `booking.hold-expiry`, v7 §10): every organization's lapsed holds become EXPIRED. */
export async function expireLapsedBookings(db: Db, organizationScopes: readonly OrganizationScope[], now: Date): Promise<number> {
  return sweepOrganizations('holds', organizationScopes, async scope => (await bookingOrgRepos(db, scope).records.expireLapsed(now)).length)
}
