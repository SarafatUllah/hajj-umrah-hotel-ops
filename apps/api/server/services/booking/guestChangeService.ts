import type { AgeGroup, BookingStatus, BookingType, ChildSide, Gender, Occupancy } from '@hajj/contracts/constants/booking'
import type { PriceSource, PriceUnit } from '@hajj/contracts/constants/pricing'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { AddGuestsInput, GuestAdditionSearchInput, StaySearchInput } from '@hajj/contracts/schemas/booking'
import { planStay, type StayHeadcount } from '../../domain/booking/allocation/planner'
import { checkStayPlan, type PlanProblem } from '../../domain/booking/allocation/stayPlanCheck'
import { stayNights } from '../../domain/booking/allocation/stayRooms'
import { effectiveBookingStatus } from '../../domain/booking/bookingView'
import { guestSlots } from '../../domain/booking/guestSlots'
import { type BookingCounts, countsOfSlots, countsWith, type RemovalRefusal, refuseHeadcount } from '../../domain/booking/headcountChanges'
import { isUnpriced, type PriceLine, type QuoteTerms } from '../../domain/booking/pricing'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, bookingRepos } from '../../repositories'
import type { BookingRow } from '../../repositories/booking'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import { bookableHotel } from '../../security/authorize'
import type { HotelScope, OrganizationScope } from '../../security/scope'
import { loadForAgency, loadForStaff } from './bookingAccess'
import { type BookingDetailDto, bookingDetail } from './bookingService'
import { loadBookingSettings } from './bookingSettingsService'
import { type Booker, claimsOwnerKey, loadStayFacts, type StayFacts } from './stayFacts'
import { assertQuota, checkInput, optionError, priceRooms, quotaHeadroomFor, type StaySearchResult, toOption } from './stayChecks'

type Db = Parameters<typeof bookingRepos>[0]
interface Actor { kind: ActorKind, id: string | null }

/** Pilgrims join bookings that have not started (a companion arriving mid-stay is a booking of their own). */
const ADDABLE: readonly BookingStatus[] = ['HELD', 'REQUESTED', 'CONFIRMED']
/** Pilgrims leave bookings that still hold seats; a pilgrim already in the house checks out instead. */
const REMOVABLE: readonly BookingStatus[] = ['HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE']
const REMOVABLE_SLOTS = ['PENDING_DETAILS', 'READY']

const REFUSALS: Record<RemovalRefusal, () => Error> = {
  LAST_PILGRIM: () => new ConflictError('LAST_PILGRIM', 'This is the booking\'s last pilgrim: cancel the booking instead'),
  CHILDREN_NEED_AN_ADULT: () => new ValidationError('CHILDREN_NEED_AN_ADULT', 'Children and infants keep an adult on their side'),
}

const countsOf = (row: BookingRow): BookingCounts => ({ maleCount: row.maleCount, femaleCount: row.femaleCount, childCount: row.childCount, infantCount: row.infantCount, totalCount: row.totalCount })

function assertStatus(row: BookingRow, allowed: readonly BookingStatus[], now: Date): void {
  const status = effectiveBookingStatus({ status: row.status as BookingStatus, holdExpiresAt: row.holdExpiresAt }, now)
  if (!allowed.includes(status)) throw new ConflictError('BOOKING_NOT_CHANGEABLE', `The pilgrims of a booking that is ${status} cannot be changed`)
}

// ---- Remove a pilgrim ----

/**
 * v7 §12 "remove a pilgrim" (staff, `booking.cancel`: a partial cancellation): the slot becomes REMOVED under the
 * booking's row lock — its seat is free at once (removed slots never count), a room the booking itself owns that
 * nobody sleeps in any more is let go (an agency's stays the agency's, for its other bookings of the same dates) —
 * the head count follows and the change is logged. The price is not changed (refunds are the client's policy).
 * Refused: a pilgrim already in the house (check out), the last pilgrim (cancel the booking), children left without
 * an adult on their side. Removing twice answers the booking unchanged. Only the booking row and the slot are locked:
 * a removal frees seats and never takes any (v7 §10's order is for changes that take seats).
 */
export async function removeGuest(ctx: AuthContext, bookingId: string, guestId: string): Promise<BookingDetailDto> {
  const row = await loadForStaff(ctx, bookingId, 'booking.cancel')
  const now = ctx.now()
  const changed = await ctx.db.transaction(async (tx) => {
    const repos = bookingOrgRepos(tx, ctx.scope)
    const booking = await repos.records.findById(row.id, { forUpdate: true })
    const slot = await repos.guests.findSlot(row.id, guestId, { forUpdate: true })
    if (!booking || !slot) throw new NotFoundError('GUEST_NOT_FOUND')
    if (slot.guest.status === 'REMOVED') return booking
    assertStatus(booking, REMOVABLE, now)
    if (!REMOVABLE_SLOTS.includes(slot.guest.status)) throw new ConflictError('GUEST_STATUS', 'A pilgrim who has arrived is checked out, not removed')
    const remaining = (await repos.guests.listForBooking(row.id)).filter(s => s.guest.id !== guestId)
    const after = countsOfSlots(remaining.map(s => ({ status: s.guest.status, ageGroup: s.guest.ageGroup as AgeGroup, gender: s.guest.gender as Gender | null })), booking.bookingType as BookingType)
    const refusal = refuseHeadcount(after, booking.bookingType as BookingType, booking.childSide as ChildSide | null)
    if (refusal) throw REFUSALS[refusal]()

    await repos.guests.updateSlot(row.id, guestId, { status: 'REMOVED' })
    const updated = (await repos.records.setCounts(row.id, after, now))!
    await repos.records.releaseEmptyClaims(row.id, now)
    await repos.records.recordChange({
      bookingId: row.id,
      kind: 'GUEST_REMOVED',
      before: { slotNo: slot.guest.slotNo, status: slot.guest.status, totalCount: booking.totalCount, infantCount: booking.infantCount },
      after: { slotNo: slot.guest.slotNo, status: 'REMOVED', totalCount: after.totalCount, infantCount: after.infantCount, ageGroup: slot.guest.ageGroup },
      actor: { kind: 'staff', id: ctx.identity.userId },
    })
    return updated
  })
  return bookingDetail(ctx.db, ctx.scope, changed, now)
}

// ---- Add pilgrims ----

/** The booking's booker, as the allocation reads it. */
function bookerOf(row: BookingRow, actor: Actor): Booker {
  if (row.bookerType === 'INDIVIDUAL') return { kind: 'INDIVIDUAL', customerId: row.customerId! }
  return { kind: 'AGENCY', agencyId: row.agencyId!, agencyUserId: actor.kind === 'agency' ? actor.id : null, staffUserId: actor.kind === 'staff' ? actor.id : null }
}


/** The joining pilgrims as a stay of the booking's own dates and type (its children sleep on its children's side). */
function additionStay(row: BookingRow, counts: GuestAdditionSearchInput): { input: StaySearchInput, headcount: StayHeadcount } {
  const bookingType = row.bookingType as BookingType
  if (bookingType === 'GROUP' && counts.maleCount + counts.femaleCount + counts.childCount !== counts.totalCount) {
    throw new ValidationError('INVALID_HEADCOUNT', 'For a group, men + women + children must equal the total')
  }
  if (bookingType === 'FAMILY' && (counts.maleCount !== 0 || counts.femaleCount !== 0 || counts.childCount !== 0)) {
    throw new ValidationError('INVALID_HEADCOUNT', 'A family gives only the total')
  }
  const childSide = row.childSide as ChildSide | null
  return {
    input: { hotelId: row.hotelId, bookingType, checkIn: row.checkIn, checkOut: row.checkOut, ...counts, childSide: childSide ?? undefined },
    headcount: { bookingType, maleCount: counts.maleCount, femaleCount: counts.femaleCount, childCount: counts.childCount, totalCount: counts.totalCount, childSide },
  }
}

/** The price the booking was made at, for the joining pilgrims too (v7 §12: "by the booking's quote or rate"). */
async function bookingQuote(db: Db, scope: OrganizationScope, row: BookingRow): Promise<QuoteTerms | null> {
  if (!row.quoteId) return null
  const quote = await bookingOrgRepos(db, scope).quotes.findById(row.quoteId)
  return quote?.amountHalalas != null && quote.unit ? { amountHalalas: quote.amountHalalas, unit: quote.unit as PriceUnit, vatIncluded: quote.vatIncluded ?? true } : null
}

/** The checks both the search and the addition make first: a booking not started, children keeping an adult. */
function assertCanAdd(row: BookingRow, counts: GuestAdditionSearchInput, now: Date): void {
  assertStatus(row, ADDABLE, now)
  const refusal = refuseHeadcount(countsWith(countsOf(row), counts), row.bookingType as BookingType, row.childSide as ChildSide | null)
  if (refusal) throw REFUSALS[refusal]()
}

/** The rooms this booking already claims (pilgrims joining them are not charged again per room). */
async function claimedRooms(db: Db, hotelScope: HotelScope, row: BookingRow): Promise<Array<{ roomId: string, occupancy: Occupancy, extraBeds: number }>> {
  const nights = stayNights(row)
  const claims = await bookingRepos(db, hotelScope).inventory.liveClaims(null, nights.from, nights.to)
  return claims.filter(c => c.bookingId === row.id).map(c => ({ roomId: c.roomId, occupancy: c.occupancy, extraBeds: c.extraBeds }))
}

/** The booking's extra beds per room type (its own rooms are among the loaded ones). */
function extraBedsByType(facts: StayFacts, own: ReadonlyArray<{ roomId: string, extraBeds: number }>): Map<string, number> {
  const byType = new Map<string, number>()
  for (const claim of own) {
    const type = facts.rooms.get(claim.roomId)?.roomTypeId
    if (type && claim.extraBeds > 0) byType.set(type, (byType.get(type) ?? 0) + claim.extraBeds)
  }
  return byType
}

/**
 * v7 §9.3 and §11 limits are per booking: an individual's rooms and each type's extra beds count what the booking
 * already holds — the planner is given only what is left of them.
 */
function withBookingLimits(facts: StayFacts, own: ReadonlyArray<{ roomId: string, extraBeds: number }>): StayFacts {
  const used = extraBedsByType(facts, own)
  const planner = facts.planner
  return {
    ...facts,
    planner: {
      ...planner,
      maxRooms: planner.maxRooms === null ? null : Math.max(0, planner.maxRooms - own.length),
      extraBedLimits: new Map([...planner.extraBedLimits].map(([type, max]) => [type, Math.max(0, max - (used.get(type) ?? 0))])),
    },
  }
}

/** The booking-wide check after the addition's own: its rooms and extra beds stay within the per-booking limits. */
function bookingLimitProblems(facts: StayFacts, own: ReadonlyArray<{ roomId: string, extraBeds: number }>, chosen: AddGuestsInput['rooms']): PlanProblem[] {
  const ownIds = new Set(own.map(c => c.roomId))
  const problems: PlanProblem[] = []
  const rooms = own.length + chosen.filter(c => !ownIds.has(c.roomId)).length
  if (facts.planner.maxRooms !== null && rooms > facts.planner.maxRooms) problems.push({ code: 'TOO_MANY_ROOMS' })
  const beds = extraBedsByType(facts, own)
  for (const c of chosen) {
    const type = facts.rooms.get(c.roomId)?.roomTypeId
    if (type && c.extraBeds > 0) beds.set(type, (beds.get(type) ?? 0) + c.extraBeds)
  }
  for (const [roomTypeId, count] of beds) if (count > (facts.planner.extraBedLimits.get(roomTypeId) ?? 0)) problems.push({ code: 'EXTRA_BED_LIMIT', roomTypeId })
  return problems
}

/**
 * v7 §12 "add a pilgrim", step 1: where the joining pilgrims can sleep — the booking's own rooms' free seats first
 * (an agency's GROUP: any of its rooms of the same dates), then new rooms, priced at the booking's quote or the rates.
 * Infants only: nothing to choose (they join the booking's rooms).
 */
async function searchAdditions(db: Db, scope: OrganizationScope, row: BookingRow, actor: Actor, counts: GuestAdditionSearchInput, now: Date): Promise<StaySearchResult> {
  assertCanAdd(row, counts, now)
  const { scope: hotelScope } = await bookableHotel(db, scope, row.hotelId)
  const booker = bookerOf(row, actor)
  const { input, headcount } = additionStay(row, counts)
  const headroom = booker.kind === 'AGENCY'
    ? await quotaHeadroomFor(db, hotelScope, booker.agencyId, input, await bookingRepos(db, hotelScope).inventory.agencyPersonsByNight(booker.agencyId, stayNights(input)))
    : null
  assertQuota(headroom, counts.totalCount)
  if (counts.totalCount === 0) return { options: [{ rooms: [], newRooms: 0, emptySeats: 0, extraBeds: 0, totalHalalas: 0, priceSource: row.priceSource as PriceSource }], quotaHeadroom: headroom }
  const settings = await loadBookingSettings(db, scope)
  const own = await claimedRooms(db, hotelScope, row)
  const facts = withBookingLimits(await loadStayFacts({ db, hotelScope, booker, input, headcount, settings, quote: await bookingQuote(db, scope, row), ownerKey: claimsOwnerKey(row) }), own)
  const paid = new Set(own.map(c => c.roomId))
  return { options: planStay(facts.planner).flatMap(plan => toOption(plan, facts, input, paid)), quotaHeadroom: headroom }
}

/**
 * v7 §12 "add a pilgrim", step 2: the chosen option is checked again under the locks — in v7 §10's order: the
 * agency's quota, the rooms by id, then the booking — and the pilgrims join: their slots and stays (the booking's own
 * claim when it has the room, else a new claim), their price merged into the booking's (a night already priced keeps
 * its frozen unit price), the head count, and the GUEST_ADDED change.
 */
async function addPilgrims(db: Db, scope: OrganizationScope, row: BookingRow, actor: Actor, body: AddGuestsInput, now: Date): Promise<BookingDetailDto> {
  const { rooms: chosen, ...counts } = body
  assertCanAdd(row, counts, now)
  const { input, headcount } = additionStay(row, counts)
  if (counts.totalCount > 0 && chosen.length === 0) throw new ValidationError('ROOMS_REQUIRED', 'Choose where the joining pilgrims sleep (search first)')
  // Every room taken goes through the plan check and the price below: infants alone (no seat) take none.
  if (counts.totalCount === 0 && chosen.length > 0) throw new ValidationError('ROOMS_NOT_ALLOWED', 'Infants alone join the booking\'s rooms: choose no rooms')
  const { scope: hotelScope } = await bookableHotel(db, scope, row.hotelId)
  const booker = bookerOf(row, actor)
  const settings = await loadBookingSettings(db, scope)
  const quote = await bookingQuote(db, scope, row)

  const changed = await db.transaction(async (tx) => {
    const repos = bookingRepos(tx, hotelScope)
    const records = bookingOrgRepos(tx, scope).records
    const nights = stayNights(input)
    const held = booker.kind === 'AGENCY' ? await repos.inventory.lockAgencyQuota(booker.agencyId, nights) : null
    const roomIds = [...new Set(chosen.map(r => r.roomId))]
    const locked = await repos.inventory.lockRooms(roomIds)
    if (locked.length !== roomIds.length) throw optionError(roomIds.filter(id => !locked.includes(id)).map(roomId => ({ code: 'ROOM_UNKNOWN', roomId })))
    await repos.bookings.expireLapsedHolds(locked, now)
    const booking = await records.findById(row.id, { forUpdate: true })
    if (!booking) throw new NotFoundError('BOOKING_NOT_FOUND')
    assertCanAdd(booking, counts, now)
    if (booker.kind === 'AGENCY') assertQuota(await quotaHeadroomFor(tx, hotelScope, booker.agencyId, input, held!), counts.totalCount)

    const own = await claimedRooms(tx, hotelScope, booking)
    const ownerKey = claimsOwnerKey(booking)
    const ownRoomIds = ownerKey.startsWith('a:')
      ? (await repos.inventory.liveClaims(null, nights.from, nights.to)).filter(c => c.ownerKey === ownerKey).map(c => c.roomId)
      : own.map(c => c.roomId)
    let lines: PriceLine[] = []
    if (counts.totalCount > 0) {
      const facts = await loadStayFacts({ db: tx, hotelScope, booker, input, headcount, settings, quote, roomIds: [...new Set([...locked, ...ownRoomIds])], ownerKey })
      const problems = [...checkStayPlan(checkInput(facts, chosen), chosen), ...bookingLimitProblems(facts, own, chosen)]
      if (problems.length > 0) throw optionError(problems)
      const priced = priceRooms(facts, input, chosen, new Set(own.map(c => c.roomId)))
      if (isUnpriced(priced)) throw new ValidationError('STAY_UNPRICED', 'Some nights of this stay have no price', { missing: priced.missing })
      lines = priced.lines
    }

    // New slots after the booking's last; infants join the first room of their side (a chosen one, else the booking's).
    const slotCount = (await bookingOrgRepos(tx, scope).guests.statuses(booking.id)).length
    const slotRooms = [...chosen, ...own.map(c => ({ roomId: c.roomId, occupancy: c.occupancy, seats: 0, extraBeds: 0 }))]
    const guests = guestSlots({ ...headcount, infantCount: counts.infantCount }, slotRooms).map(g => ({ ...g, slotNo: g.slotNo + slotCount }))
    await repos.bookings.appendGuests({ booking, rooms: chosen.map(r => ({ ...r, ownedByAgency: ownerKey.startsWith('a:') })), guests })
    await records.mergePriceLines(booking.id, lines)
    const updated = (await records.setCounts(booking.id, countsWith(countsOf(booking), counts), now))!
    await records.recordChange({
      bookingId: booking.id,
      kind: 'GUEST_ADDED',
      before: { totalCount: booking.totalCount, infantCount: booking.infantCount },
      after: { totalCount: updated.totalCount, infantCount: updated.infantCount, added: counts, rooms: chosen.length },
      actor,
    })
    return updated
  }).catch(rethrowDbError)
  return bookingDetail(db, scope, changed, now)
}

// ---- Agency portal (its own bookings; v7 §12: agencies add pilgrims themselves) ----

const agencyActor = (ctx: AgencyContext): Actor => ({ kind: 'agency', id: ctx.identity.agencyUserId })

export async function searchAgencyGuestAdditions(ctx: AgencyContext, bookingId: string, counts: GuestAdditionSearchInput): Promise<StaySearchResult> {
  return searchAdditions(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId), agencyActor(ctx), counts, ctx.now())
}
export async function addAgencyGuests(ctx: AgencyContext, bookingId: string, body: AddGuestsInput): Promise<BookingDetailDto> {
  return addPilgrims(ctx.db, ctx.scope, await loadForAgency(ctx, bookingId), agencyActor(ctx), body, ctx.now())
}

// ---- Staff (`booking.edit` on the hotel) ----

const staffActor = (ctx: AuthContext): Actor => ({ kind: 'staff', id: ctx.identity.userId })

export async function searchGuestAdditions(ctx: AuthContext, bookingId: string, counts: GuestAdditionSearchInput): Promise<StaySearchResult> {
  return searchAdditions(ctx.db, ctx.scope, await loadForStaff(ctx, bookingId, 'booking.edit'), staffActor(ctx), counts, ctx.now())
}
export async function addGuests(ctx: AuthContext, bookingId: string, body: AddGuestsInput): Promise<BookingDetailDto> {
  return addPilgrims(ctx.db, ctx.scope, await loadForStaff(ctx, bookingId, 'booking.edit'), staffActor(ctx), body, ctx.now())
}
