import type { AgeGroup, BookingStatus, BookingType, ChildSide, GuestStatus, Occupancy } from '@hajj/contracts/constants/booking'
import type { ChangeDatesInput, DateChangeSearchInput, StaySearchInput } from '@hajj/contracts/schemas/booking'
import { type IsoDate, todayInTimezone } from '@hajj/contracts/utils/dates'
import { stayNights } from '../../domain/booking/allocation/stayRooms'
import { addMonths } from '../../domain/booking/guestRules'
import { effectiveBookingStatus } from '../../domain/booking/bookingView'
import { reseatSlots, type SeatedSlot } from '../../domain/booking/guestSlots'
import { rethrowDbError } from '../../errors/dbErrors'
import { ConflictError, NotFoundError, ValidationError } from '../../errors/domainError'
import { bookingOrgRepos, bookingRepos } from '../../repositories'
import type { BookingRow, GuestSlotRow } from '../../repositories/booking'
import type { AuthContext } from '../../security/authContext'
import { bookableHotel } from '../../security/authorize'
import { loadForStaff } from './bookingAccess'
import { type BookingDetailDto, bookingDetail } from './bookingService'
import { loadBookingSettings } from './bookingSettingsService'
import { recheckStay, searchStay } from './holdService'
import { planExtraBedTasks } from './hotelTaskService'
import { type Actor, bookerOf, claimsOwnerKey, headcountOf } from './stayFacts'
import { assertApprovedAgency, optionError, type StaySearchResult } from './stayChecks'

/** Bookings whose dates can change: not begun, and holding seats now (a pending hold past its expiry holds none). */
const DATE_CHANGEABLE: readonly BookingStatus[] = ['HELD', 'REQUESTED', 'CONFIRMED']
/** Slots of a stay nobody has begun (a removed slot stays removed). */
const NOT_BEGUN: readonly string[] = ['PENDING_DETAILS', 'READY', 'REMOVED'] satisfies GuestStatus[]

const staffActor = (ctx: AuthContext): Actor => ({ kind: 'staff', id: ctx.identity.userId })

/** What the search and the change both check, on the booking and its slots as read. */
function assertDatesChangeable(row: BookingRow, slotStatuses: readonly string[], dates: { checkIn: IsoDate, checkOut: IsoDate }, today: IsoDate, now: Date): void {
  const status = effectiveBookingStatus({ status: row.status as BookingStatus, holdExpiresAt: row.holdExpiresAt }, now)
  if (!DATE_CHANGEABLE.includes(status)) throw new ConflictError('BOOKING_NOT_CHANGEABLE', `The dates of a booking that is ${status} cannot change`)
  if (slotStatuses.some(s => !NOT_BEGUN.includes(s))) throw new ConflictError('STAY_BEGUN', 'Pilgrims of this booking arrived (or did not come): move rooms or check them out instead')
  if (dates.checkIn < today) throw new ValidationError('DATES_IN_PAST', 'The new stay starts today or later')
  if (dates.checkIn === row.checkIn && dates.checkOut === row.checkOut) throw new ValidationError('SAME_DATES', 'These are the booking\'s dates already')
}

/** The booking's pilgrims as a stay on the new dates: its hotel, type, head count and children's side. */
function stayOnNewDates(row: BookingRow, dates: DateChangeSearchInput): StaySearchInput {
  return {
    hotelId: row.hotelId,
    bookingType: row.bookingType as BookingType,
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    maleCount: row.maleCount,
    femaleCount: row.femaleCount,
    childCount: row.childCount,
    infantCount: row.infantCount,
    totalCount: row.totalCount,
    childSide: (row.childSide as ChildSide | null) ?? undefined,
    quoteId: dates.quoteId,
  }
}

/** The booking's live slots and the side each sleeps on now. */
const liveSlots = (slots: readonly GuestSlotRow[]): SeatedSlot[] => slots
  .filter(s => s.guest.status !== 'REMOVED')
  .map(s => ({ id: s.guest.id, slotNo: s.guest.slotNo, ageGroup: s.guest.ageGroup as AgeGroup, side: s.occupancy as Occupancy | null }))

/**
 * v7 §12 date change, step 1 (staff, `booking.edit`): the options for the booking's pilgrims on new dates — "in
 * effect a new allocation", planned as if the booking had already given up its own rooms, seats and quota, and
 * priced per night at the rates or at the agency's quote for the new dates (its old quote was for the old ones).
 * Nothing is locked or saved.
 */
export async function searchDateChange(ctx: AuthContext, bookingId: string, body: DateChangeSearchInput): Promise<StaySearchResult> {
  const row = await loadForStaff(ctx, bookingId, 'booking.edit')
  const { hotel } = await bookableHotel(ctx.db, ctx.scope, row.hotelId)
  const now = ctx.now()
  assertDatesChangeable(row, await bookingOrgRepos(ctx.db, ctx.scope).guests.statuses(row.id), body, todayInTimezone(hotel.timezone, now), now)
  return searchStay(ctx.db, ctx.scope, bookerOf(row, staffActor(ctx)), stayOnNewDates(row, body), now, { exceptBookingId: row.id })
}

/**
 * v7 §12 date change, step 2: the whole booking moves to the new dates in the rooms of the chosen option — or
 * nothing changes ("all or nothing"). One transaction in v7 §10's lock order (the agency's quota lock, the chosen
 * rooms by id, the booking), then the option is checked again as a hold is (`recheckStay`), as if the booking had
 * given up its own rooms, seats and quota (giving them up takes no lock: it frees seats, never takes any). Its
 * claims, stays and price lines are replaced: every live slot keeps its details and sleeps on its side in the new
 * rooms; the price is per night again (the new quote's, or the rates); a confirmed booking's extra-bed tasks are
 * planned again and its new quote becomes ACCEPTED; DATES_CHANGED is logged. Only a booking nobody has arrived for,
 * to dates from today on. Age groups stay as judged for the old check-in. No customer request lock: a date change
 * opens no request (that lock guards the count of open requests). Changes that read the booking before their locks
 * (adding pilgrims, a room move) check its dates again under its lock.
 */
export async function changeDates(ctx: AuthContext, bookingId: string, body: ChangeDatesInput): Promise<BookingDetailDto> {
  const row = await loadForStaff(ctx, bookingId, 'booking.edit')
  const { hotel, scope: hotelScope } = await bookableHotel(ctx.db, ctx.scope, row.hotelId)
  const now = ctx.now()
  const today = todayInTimezone(hotel.timezone, now)
  const booker = bookerOf(row, staffActor(ctx))
  await assertApprovedAgency(ctx.db, ctx.scope, booker)
  const settings = await loadBookingSettings(ctx.db, ctx.scope)
  const roomIds = [...new Set(body.rooms.map(r => r.roomId))]

  const changed = await ctx.db.transaction(async (tx) => {
    const repos = bookingRepos(tx, hotelScope)
    const org = bookingOrgRepos(tx, ctx.scope)
    const held = booker.kind === 'AGENCY' ? await repos.inventory.lockAgencyQuota(booker.agencyId, stayNights(body), row.id) : null
    const locked = await repos.inventory.lockRooms(roomIds)
    if (locked.length !== roomIds.length) throw optionError(roomIds.filter(id => !locked.includes(id)).map(roomId => ({ code: 'ROOM_UNKNOWN', roomId })))
    await repos.bookings.expireLapsedHolds(locked, now)
    const booking = await org.records.findById(row.id, { forUpdate: true })
    if (!booking) throw new NotFoundError('BOOKING_NOT_FOUND')
    const slots = await org.guests.listForBooking(booking.id)
    assertDatesChangeable(booking, slots.map(s => s.guest.status), body, today, now)

    // The head count as it is under the lock (pilgrims may have joined or left since the request was read).
    const input = { ...stayOnNewDates(booking, body), rooms: body.rooms }
    const { quote, priced } = await recheckStay({ db: tx, scope: ctx.scope, hotelScope, booker, input, headcount: headcountOf(input, settings), settings, lockedRoomIds: locked, held, now, exceptBookingId: booking.id })
    const seats = reseatSlots(liveSlots(slots), body.rooms, { bookingType: booking.bookingType as BookingType, childSide: booking.childSide as ChildSide | null })
    if (!seats) throw new ConflictError('SLOTS_DO_NOT_FIT', 'The booking\'s pilgrims do not fit these rooms side by side; search again')

    const before = await org.records.details(booking.id)
    const ownedByAgency = claimsOwnerKey(booking).startsWith('a:')
    const updated = await org.records.rebook({ booking, checkIn: body.checkIn, checkOut: body.checkOut, quoteId: quote?.id ?? null, priceSource: priced.source, rooms: body.rooms.map(r => ({ ...r, ownedByAgency })), seats, priceLines: priced.lines, at: now })
    if (!updated) throw new NotFoundError('BOOKING_NOT_FOUND')
    await org.passportScans.retainUntil(booking.id, addMonths(updated.checkOut, settings.passportImageRetentionMonths), now)
    await org.hotelTasks.cancelOpenForBooking(booking.id, now)
    if (updated.status === 'CONFIRMED') {
      await planExtraBedTasks(tx, ctx.scope, updated)
      if (quote) await org.quotes.markAccepted(quote.id, now)
    }
    await org.records.recordChange({
      bookingId: booking.id,
      kind: 'DATES_CHANGED',
      before: { checkIn: booking.checkIn, checkOut: booking.checkOut, roomIds: [...new Set(before.rooms.map(r => r.roomId))], quoteId: booking.quoteId, totalHalalas: before.priceLines.reduce((sum, line) => sum + line.amountHalalas, 0) },
      after: { checkIn: updated.checkIn, checkOut: updated.checkOut, roomIds, quoteId: updated.quoteId, totalHalalas: priced.totalHalalas, priceSource: priced.source },
      actor: staffActor(ctx),
    })
    return updated
  }).catch(rethrowDbError)
  return bookingDetail(ctx.db, ctx.scope, changed, now)
}
