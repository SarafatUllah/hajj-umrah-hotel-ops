import type { PriceSource } from '@hajj/contracts/constants/pricing'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { HoldRequestInput, StaySearchInput } from '@hajj/contracts/schemas/booking'
import { type IsoDate, todayInTimezone } from '@hajj/contracts/utils/dates'
import { planStay, type StayHeadcount } from '../../domain/booking/allocation/planner'
import { checkStayPlan, type ChosenRoom } from '../../domain/booking/allocation/stayPlanCheck'
import { stayNights } from '../../domain/booking/allocation/stayRooms'
import { guestSlots } from '../../domain/booking/guestSlots'
import { isUnpriced, type PricedStay } from '../../domain/booking/pricing'
import { documentNo } from '../../domain/booking/references'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, bookingRepos } from '../../repositories'
import type { BookingSettingRow } from '../../repositories/booking'
import { bookableHotel } from '../../security/authorize'
import type { HotelScope, OrganizationScope } from '../../security/scope'
import { isCustomerOpen } from '../accounts'
import { loadBookingSettings } from './bookingSettingsService'
import { agencyOwnerKey, type Booker, headcountOf, loadStayFacts } from './stayFacts'
import { assertApprovedAgency, assertQuota, checkInput, optionError, priceRooms, quotaHeadroomFor, type StaySearchResult, toOption, usableQuote, type UsableQuote } from './stayChecks'
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
 * v7 §9: the two or three best complete options for a stay, priced (nothing is locked or saved). An agency's
 * request beyond its quota fails at once with the number still possible (422 `QUOTA_EXCEEDED`). `exceptBookingId`:
 * a booking planned again on new dates — its own claims, seats and persons count as given up (v7 §12 date change).
 */
export async function searchStay(db: Db, scope: OrganizationScope, booker: Booker, input: StaySearchInput, now: Date, options: { exceptBookingId?: string } = {}): Promise<StaySearchResult> {
  const { scope: hotelScope } = await bookableHotel(db, scope, input.hotelId)
  await assertApprovedAgency(db, scope, booker)
  const settings = await loadBookingSettings(db, scope)
  const headcount = headcountOf(input, settings)
  const quote = await usableQuote(db, scope, booker, input, headcount, now)
  const except = options.exceptBookingId
  const headroom = booker.kind === 'AGENCY'
    ? await quotaHeadroomFor(db, hotelScope, booker.agencyId, input, await bookingRepos(db, hotelScope).inventory.agencyPersonsByNight(booker.agencyId, stayNights(input), except ?? null))
    : null
  assertQuota(headroom, input.totalCount)
  const facts = await loadStayFacts({ db, hotelScope, booker, input, headcount, settings, quote: quote?.terms ?? null, exceptBookingId: except })
  return { options: planStay(facts.planner).flatMap(plan => toOption(plan, facts, input)), quotaHeadroom: headroom }
}

/** What a hold or a date change checks again under its locks: the stay with the chosen rooms. */
export interface StayRecheck {
  db: Db
  scope: OrganizationScope
  hotelScope: HotelScope
  booker: Booker
  input: StaySearchInput & { rooms: readonly ChosenRoom[] }
  headcount: StayHeadcount
  settings: Pick<BookingSettingRow, 'individualMaxRooms'>
  /** The rooms locked (in id order) by the caller. */
  lockedRoomIds: readonly string[]
  /** The agency's persons per night, read under its quota lock (null: an individual booker). */
  held: ReadonlyMap<IsoDate, number> | null
  now: Date
  /** A booking planned again on new dates: its own claims, seats and persons count as given up. */
  exceptBookingId?: string
}

/**
 * v7 §10 step 4, after the locks: everything is checked again on fresh reads — the quote as it is now, the quota,
 * every chosen room for every night (inventory, blocks, seats, owner, gender, the agency's own rooms first), the
 * option's rules, the price. A room taken meanwhile is 409 `OPTION_UNAVAILABLE`; a wrong option 422 `INVALID_OPTION`.
 */
export async function recheckStay(c: StayRecheck): Promise<{ quote: UsableQuote | null, priced: PricedStay }> {
  const quote = await usableQuote(c.db, c.scope, c.booker, c.input, c.headcount, c.now)
  if (c.booker.kind === 'AGENCY') assertQuota(await quotaHeadroomFor(c.db, c.hotelScope, c.booker.agencyId, c.input, c.held!), c.input.totalCount)
  const nights = stayNights(c.input)
  const ownerKey = c.booker.kind === 'AGENCY' && c.input.bookingType === 'GROUP' ? agencyOwnerKey(c.booker.agencyId) : null
  const ownRoomIds = ownerKey
    ? (await bookingRepos(c.db, c.hotelScope).inventory.liveClaims(null, nights.from, nights.to)).filter(claim => claim.ownerKey === ownerKey && claim.bookingId !== c.exceptBookingId).map(claim => claim.roomId)
    : []
  const facts = await loadStayFacts({ db: c.db, hotelScope: c.hotelScope, booker: c.booker, input: c.input, headcount: c.headcount, settings: c.settings, quote: quote?.terms ?? null, roomIds: [...new Set([...c.lockedRoomIds, ...ownRoomIds])], exceptBookingId: c.exceptBookingId })
  const problems = checkStayPlan(checkInput(facts, c.input.rooms), c.input.rooms)
  if (problems.length > 0) throw optionError(problems)
  const priced = priceRooms(facts, c.input, c.input.rooms)
  if (isUnpriced(priced)) throw new ValidationError('STAY_UNPRICED', 'Some nights of this stay have no price', { missing: priced.missing })
  return { quote, priced }
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
      // Under the request lock an account closure also takes: a request waiting behind one finds the account closed.
      if (!await isCustomerOpen(tx, scope, booker.customerId)) throw new ConflictError('ACCOUNT_CLOSED', 'This account is closed')
      if (open >= settings.individualMaxOpenRequests) throw new ConflictError('TOO_MANY_OPEN_REQUESTS', `At most ${settings.individualMaxOpenRequests} open request(s) at a time; wait for the hotel's answer`)
    }
    const locked = await repos.inventory.lockRooms(roomIds)
    if (locked.length !== roomIds.length) throw optionError(roomIds.filter(id => !locked.includes(id)).map(roomId => ({ code: 'ROOM_UNKNOWN', roomId })))
    await repos.bookings.expireLapsedHolds(locked, now)
    const { quote, priced } = await recheckStay({ db: tx, scope, hotelScope, booker, input, headcount, settings, lockedRoomIds: locked, held, now })

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
