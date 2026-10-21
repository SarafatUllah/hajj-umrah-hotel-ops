import type { BookingType, Occupancy } from '@hajj/contracts/constants/booking'
import type { PriceSource, PriceUnit, QuoteStatus } from '@hajj/contracts/constants/pricing'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { HoldRequestInput, StaySearchInput } from '@hajj/contracts/schemas/booking'
import { eachDate, todayInTimezone } from '@hajj/contracts/utils/dates'
import { type PlannerInput, planStay, type StayHeadcount, type StayPlan } from '../../domain/booking/allocation/planner'
import { quotaHeadroom } from '../../domain/booking/allocation/quota'
import { checkStayPlan, type ChosenRoom, type PlanProblem, type PlanProblemCode } from '../../domain/booking/allocation/stayPlanCheck'
import { stayNights } from '../../domain/booking/allocation/stayRooms'
import { guestSlots } from '../../domain/booking/guestSlots'
import { isUnpriced, priceStay, type QuoteTerms } from '../../domain/booking/pricing'
import { effectiveQuoteStatus, quoteFitsStay } from '../../domain/booking/quotes'
import { documentNo } from '../../domain/booking/references'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, bookingRepos } from '../../repositories'
import { bookableHotel } from '../../security/authorize'
import type { HotelScope, OrganizationScope } from '../../security/scope'
import { findAgencyBrief } from '../accounts'
import { loadBookingSettings } from './bookingSettingsService'
import { agencyOwnerKey, type Booker, headcountOf, loadStayFacts, type StayFacts } from './stayFacts'
import { sweepOrganizations } from './sweep'

type Db = Parameters<typeof bookingRepos>[0]

export interface StayOptionRoom { roomId: string, roomNumber: string, floorLevel: number, roomTypeId: string, occupancy: Occupancy, seats: number, extraBeds: number, existing: boolean }

/** One complete option (v7 §9.2 step 7), priced on its actual rooms (empty seats never charged). */
export interface StayOption { rooms: StayOptionRoom[], newRooms: number, emptySeats: number, extraBeds: number, totalHalalas: number, priceSource: PriceSource }

export interface StaySearchResult {
  options: StayOption[]
  /** How many more persons the agency may still hold on every night of the stay (v7 §10); null = no quota. */
  quotaHeadroom: number | null
}

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

/** Problems that depend on what happened since the search ("someone was faster": search again). The rest mean the request itself is wrong. */
const UNAVAILABLE: ReadonlySet<PlanProblemCode> = new Set(['ROOM_NOT_SELLABLE', 'ROOM_TAKEN', 'SEATS', 'EXTRA_BEDS', 'OWN_ROOMS_FIRST'])

function optionError(problems: readonly PlanProblem[]): Error {
  return problems.every(p => UNAVAILABLE.has(p.code))
    ? new ConflictError('OPTION_UNAVAILABLE', 'Some rooms of this option are no longer available; search again', { problems })
    : new ValidationError('INVALID_OPTION', 'This option does not fit the booking', { problems })
}

/** v7 §9.2 step 1: more persons than the quota leaves fails, saying how many are still possible. */
function assertQuota(headroom: number | null, persons: number): void {
  if (headroom !== null && persons > headroom) throw new ValidationError('QUOTA_EXCEEDED', `The agency may hold at most ${headroom} more persons on these nights`, { maxPersons: headroom })
}

async function quotaHeadroomFor(db: Db, hotelScope: HotelScope, agencyId: string, input: StaySearchInput, held: ReadonlyMap<string, number>): Promise<number | null> {
  const rows = await bookingRepos(db, hotelScope).agencyQuotas.list()
  return quotaHeadroom({ agencyId, nights: eachDate(stayNights(input)), rows, heldByNight: held })
}

/** Defence in depth: the agency routes already require an approved agency; staff act for approved agencies only. */
async function assertApprovedAgency(db: Db, scope: OrganizationScope, booker: Booker): Promise<void> {
  if (booker.kind !== 'AGENCY') return
  const agency = await findAgencyBrief(db, scope, booker.agencyId)
  if (!agency || agency.status !== 'APPROVED') throw new ValidationError('AGENCY_NOT_APPROVED', 'Bookings are for approved agencies only')
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

/** The price of the rooms as chosen: pilgrims on regular beds by the seat price, extra beds at the policy price. */
function priceRooms(facts: StayFacts, input: StaySearchInput, rooms: readonly ChosenRoom[]) {
  return priceStay({
    ...facts.pricing,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    rooms: rooms.map(r => ({ roomTypeId: facts.rooms.get(r.roomId)!.roomTypeId, seats: r.seats - r.extraBeds, extraBeds: r.extraBeds })),
  })
}

/**
 * The re-check's input: the planner's rooms (priced, the booker's own rooms included), plus any chosen room the
 * planner left out for want of a price — pricing refuses it then, with what is missing, rather than "unknown room".
 */
function checkInput(facts: StayFacts, chosen: readonly ChosenRoom[]): PlannerInput {
  const planned = new Set(facts.planner.rooms.map(r => r.id))
  const unpriced = [...new Set(chosen.map(c => c.roomId))].filter(id => !planned.has(id) && facts.rooms.has(id)).map(id => ({ ...facts.rooms.get(id)!, price: 0 }))
  return { ...facts.planner, rooms: [...facts.planner.rooms, ...unpriced] }
}

function toOption(plan: StayPlan, facts: StayFacts, input: StaySearchInput): StayOption[] {
  const priced = priceRooms(facts, input, plan.rooms)
  if (isUnpriced(priced)) return []
  const rooms = plan.rooms.map((r) => {
    const room = facts.rooms.get(r.roomId)!
    return { roomId: r.roomId, roomNumber: room.roomNumber, floorLevel: room.floorLevel, roomTypeId: r.roomTypeId, occupancy: r.occupancy, seats: r.seats, extraBeds: r.extraBeds, existing: r.existing }
  })
  return [{ rooms, newRooms: plan.newRooms, emptySeats: plan.emptySeats, extraBeds: plan.extraBeds, totalHalalas: priced.totalHalalas, priceSource: priced.source }]
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
