import type { BookingStatus } from '@hajj/contracts/constants/booking'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { CancelBookingInput } from '@hajj/contracts/schemas/booking'
import { effectiveBookingStatus } from '../../domain/booking/bookingView'
import { ConflictError, NotFoundError } from '../../errors/domainError'
import { publishEvent } from '../../events/bus'
import { bookingOrgRepos } from '../../repositories'
import type { BookingRow } from '../../repositories/booking'
import type { AgencyContext } from '../../security/agencyContext'
import type { AuthContext } from '../../security/authContext'
import type { OrganizationScope } from '../../security/scope'
import { loadForAgency, loadForStaff } from './bookingAccess'
import { bookingCancelledEvent } from './bookingEvents'
import { type BookingDetailDto, bookingDetail } from './bookingService'

type Db = Parameters<typeof bookingOrgRepos>[0]
interface Actor { kind: ActorKind, id: string | null }

/** Statuses staff can cancel from: still pending, or confirmed with nobody in the house yet. */
const CANCELLABLE: readonly BookingStatus[] = ['HELD', 'REQUESTED', 'CONFIRMED']
/** An agency lets go only of its own hold (v7 §12: other changes need the manager). */
const AGENCY_RELEASABLE: readonly BookingStatus[] = ['HELD']

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
    if (actor.kind === 'agency' && status === 'CONFIRMED') throw new ConflictError('CANCEL_BY_HOTEL', 'Ask the hotel to cancel a confirmed booking')
    if (!allowed.includes(status)) throw new ConflictError('BOOKING_NOT_CANCELLABLE', `A booking that is ${status} cannot be cancelled`)
    const updated = (await repos.records.cancel(locked.id, { at: now, by: actor.kind === 'staff' ? actor.id : null, reason }))!
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
