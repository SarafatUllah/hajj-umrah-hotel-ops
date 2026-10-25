import { type BookingStatus, PENDING_BOOKING_STATUSES } from '@hajj/contracts/constants/booking'
import { todayInTimezone } from '@hajj/contracts/utils/dates'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { CancelBookingInput } from '@hajj/contracts/schemas/booking'
import { effectiveBookingStatus } from '../../domain/booking/bookingView'
import { ConflictError, NotFoundError } from '../../errors/domainError'
import { publishEvent } from '../../events/bus'
import { bookingOrgRepos } from '../../repositories'
import type { BookingRow } from '../../repositories/booking'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import type { CustomerContext } from '../../security/customerContext'
import type { OrganizationScope } from '../../security/scope'
import { loadForAgency, loadForCustomer, loadForStaff } from './bookingAccess'
import { bookingCancelledEvent } from './bookingEvents'
import { eraseBookingData } from './guestRetention'
import { type BookingDetailDto, bookingDetail } from './bookingService'

type Db = Parameters<typeof bookingOrgRepos>[0]
interface Actor { kind: ActorKind, id: string | null }

/** Statuses staff can cancel from: still pending, or confirmed with nobody in the house yet. */
const CANCELLABLE: readonly BookingStatus[] = ['HELD', 'REQUESTED', 'CONFIRMED']
/** An agency lets go only of its own hold (v7 §12: other changes need the manager). */
const AGENCY_RELEASABLE: readonly BookingStatus[] = ['HELD']
/** A customer withdraws only an open request; once confirmed, the hotel cancels (its cancellation policy). */
const CUSTOMER_WITHDRAWABLE: readonly BookingStatus[] = ['REQUESTED']

/**
 * v7 §12 cancel: the whole booking becomes CANCELLED under its row lock — its room claims follow (database trigger), so
 * the seats are free at once; the open housekeeping tasks are cancelled; the quote it used stays ACCEPTED (never
 * reusable); the change is logged and `booking.cancelled` published (the booker is told). The reason is kept on the
 * booking (erased with it by the retention sweep), never in the append-only change log. Cancelling twice answers the
 * booking unchanged; a booking with pilgrims in the house is checked out instead (409 `BOOKING_IN_HOUSE`). The
 * statuses `allowed` are judged under the lock (a booking confirmed meanwhile is not the agency's to cancel). Only the
 * booking row is locked, not the rooms: a cancellation frees seats and never takes any (v7 §10's order is for takers).
 */
async function cancel(db: Db, scope: OrganizationScope, row: BookingRow, actor: Actor, reason: string | null, now: Date, allowed: readonly BookingStatus[]): Promise<BookingDetailDto> {
  const cancelled = await db.transaction(async (tx) => {
    const repos = bookingOrgRepos(tx, scope)
    const locked = await repos.records.findById(row.id, { forUpdate: true })
    if (!locked) throw new NotFoundError('BOOKING_NOT_FOUND')
    if (locked.status === 'CANCELLED') return locked
    if (locked.status === 'IN_HOUSE') throw new ConflictError('BOOKING_IN_HOUSE', 'Pilgrims of this booking are in the house: check them out instead')
    const status = effectiveBookingStatus({ status: locked.status as BookingStatus, holdExpiresAt: locked.holdExpiresAt }, now)
    if (actor.kind !== 'staff' && status === 'CONFIRMED') throw new ConflictError('CANCEL_BY_HOTEL', 'Ask the hotel to cancel a confirmed booking')
    if (!allowed.includes(status)) throw new ConflictError('BOOKING_NOT_CANCELLABLE', `A booking that is ${status} cannot be cancelled`)
    const updated = (await repos.records.cancel(locked.id, { at: now, by: actor.kind === 'staff' ? actor.id : null, reason }))!
    // A booking that will not happen needs no passport photo: its readings go now, its images at the next sweep.
    await repos.passportScans.expireForBookings([locked.id], todayInTimezone('UTC', now), now)
    await repos.hotelTasks.cancelOpenForBooking(locked.id, now)
    // The quote it used is spent either way (never reusable): ACCEPTED, as a confirmation would have marked it.
    if (locked.quoteId) await repos.quotes.markAccepted(locked.quoteId, now)
    await repos.records.recordChange({ bookingId: locked.id, kind: 'CANCELLED', before: { status: locked.status }, after: { status: 'CANCELLED' }, actor })
    await publishEvent(tx, bookingCancelledEvent(updated, locked.status as BookingStatus, actor.kind, now))
    return updated
  })
  return bookingDetail(db, scope, cancelled, now)
}

/** Ops console (`booking.cancel` on the hotel, v7 §12): cancel a pending or confirmed booking, with a reason. */
export async function cancelBooking(ctx: AuthContext, bookingId: string, input: CancelBookingInput): Promise<BookingDetailDto> {
  // An inactive hotel's bookings can still be cancelled: that only frees seats.
  const row = await loadForStaff(ctx, bookingId, 'booking.cancel', { allowInactive: true })
  return cancel(ctx.db, ctx.scope, row, { kind: 'staff', id: ctx.identity.userId }, input.reason, ctx.now(), CANCELLABLE)
}

/**
 * Agency portal: an agency lets go of its own hold before it confirms it (the seats are free at once). A confirmed
 * booking is cancelled by the hotel (v7 §12: changes other than adding pilgrims need the manager) — 409
 * `CANCEL_BY_HOTEL`.
 */
export async function releaseAgencyHold(ctx: AgencyContext, bookingId: string): Promise<BookingDetailDto> {
  const row = await loadForAgency(ctx, bookingId)
  return cancel(ctx.db, ctx.scope, row, { kind: 'agency', id: ctx.identity.agencyUserId }, null, ctx.now(), AGENCY_RELEASABLE)
}

/** Public site (v7 §6, §10): a customer withdraws their open request; its rooms are free at once. */
export async function withdrawCustomerRequest(ctx: CustomerContext, bookingId: string): Promise<BookingDetailDto> {
  const row = await loadForCustomer(ctx, bookingId)
  return cancel(ctx.db, ctx.scope, row, { kind: 'customer', id: ctx.scope.customerId }, null, ctx.now(), CUSTOMER_WITHDRAWABLE)
}

/**
 * Step 15b, inside an account closure's transaction: under the customer's request lock (taken first, as a new request
 * does), a stay not over yet — confirmed with a check-out after today (UTC), or pilgrims in the house — refuses the
 * closure (409 `ACTIVE_BOOKINGS`, with their numbers: the hotel cancels them; "today" in UTC, like the retention sweep —
 * conservative east of UTC); the open requests are withdrawn and their personal data erased at once (the pilgrims'
 * copies, free text, passport scans: no stay will use them). One the hotel confirmed meanwhile (judged again under
 * its row lock) refuses the closure the same way. Returns the withdrawn booking numbers. Past stays keep naming the
 * (anonymized) customer and keep their data until the retention sweep.
 */
export async function releaseCustomerBookings(db: Db, scope: OrganizationScope, customerId: string, now: Date): Promise<string[]> {
  const records = bookingOrgRepos(db, scope).records
  await records.lockOpenRequests(customerId, now)
  const today = todayInTimezone('UTC', now)
  const live = (await records.liveForCustomer(customerId)).map(row => ({ row, status: effectiveBookingStatus({ status: row.status as BookingStatus, holdExpiresAt: row.holdExpiresAt }, now) }))
  const active = live.filter(b => b.status === 'IN_HOUSE' || (b.status === 'CONFIRMED' && b.row.checkOut > today))
  if (active.length > 0) {
    throw new ConflictError('ACTIVE_BOOKINGS', 'Ask the hotel to cancel your confirmed stays before closing the account', { bookingNos: active.map(b => b.row.bookingNo) })
  }
  const open = live.filter(b => (PENDING_BOOKING_STATUSES as readonly string[]).includes(b.status))
  for (const { row } of open) {
    await cancel(db, scope, row, { kind: 'customer', id: customerId }, null, now, PENDING_BOOKING_STATUSES).catch((error: unknown) => {
      if (error instanceof ConflictError && error.code === 'CANCEL_BY_HOTEL') {
        throw new ConflictError('ACTIVE_BOOKINGS', 'Ask the hotel to cancel your confirmed stays before closing the account', { bookingNos: [row.bookingNo] })
      }
      throw error
    })
  }
  if (open.length > 0) await eraseBookingData(db, scope, open.map(b => b.row.id), today, now)
  return open.map(b => b.row.bookingNo)
}
