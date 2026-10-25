import type { BookingStatus } from '@hajj/contracts/constants/booking'
import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { BookingCancelledV1, BookingConfirmedV1, ConfirmedByKind } from '@hajj/contracts/events/domainEvents'
import { newEvent } from '../../events/bus'
import { isSmsEnabled, useSmsSender } from '../../notifications/sms'
import { tenantRepos } from '../../repositories'
import type { BookingRow } from '../../repositories/booking'
import type { OrganizationScope } from '../../security/scope'
import { findBookerPhone } from '../accounts'

type Db = Parameters<typeof tenantRepos>[0]

/** The actor as an event names it (the system never confirms or cancels). */
const actorKindOf = (actor: ActorKind): ConfirmedByKind => (actor === 'agency' || actor === 'customer' ? actor : 'staff')

/** What both booking events say about the booking. */
type BookingFacts = Pick<BookingConfirmedV1['payload'], 'bookingId' | 'bookingNo' | 'hotelId' | 'bookerType' | 'agencyId' | 'customerId' | 'checkIn' | 'checkOut'>
const bookingFacts = (row: BookingRow): BookingFacts => ({
  bookingId: row.id,
  bookingNo: row.bookingNo,
  hotelId: row.hotelId,
  bookerType: row.bookerType as 'AGENCY' | 'INDIVIDUAL',
  agencyId: row.agencyId,
  customerId: row.customerId,
  checkIn: row.checkIn,
  checkOut: row.checkOut,
})

/** `booking.confirmed` v1 for a booking just confirmed by `actor`. */
export function bookingConfirmedEvent(row: BookingRow, actor: ActorKind, now: Date): BookingConfirmedV1 {
  return newEvent<BookingConfirmedV1>('booking.confirmed', 1, row.organizationId, { ...bookingFacts(row), confirmedBy: actorKindOf(actor) }, now)
}

/** `booking.cancelled` v1 for a booking just cancelled by `actor` from `previousStatus`. */
export function bookingCancelledEvent(row: BookingRow, previousStatus: BookingStatus, actor: ActorKind, now: Date): BookingCancelledV1 {
  return newEvent<BookingCancelledV1>('booking.cancelled', 1, row.organizationId, { ...bookingFacts(row), previousStatus, cancelledBy: actorKindOf(actor) }, now)
}

/** Texts the booker of a booking event, when text messages are configured and the booker has a phone. */
async function textBooker(tx: Db, scope: OrganizationScope, payload: BookingFacts, text: (hotelName: string) => string): Promise<void> {
  if (!isSmsEnabled()) return
  const phone = await findBookerPhone(tx, scope, payload)
  if (!phone) return
  const hotel = await tenantRepos(tx, scope).hotels.findById(payload.hotelId)
  await useSmsSender().send({ to: phone, text: text(hotel?.name ?? 'the hotel') })
}

/**
 * `booking.confirmed` → the booker learns it by text message when someone else confirmed it: a customer whose
 * request staff confirmed (v7 §7 REQUESTED), or an agency whose booking staff made on its behalf. A booker who
 * confirmed it themselves sees it already. Nothing is sent while text messages are not configured; a failed message
 * throws, so the job is retried.
 */
export async function notifyBookingConfirmed(tx: Db, scope: OrganizationScope, event: BookingConfirmedV1): Promise<void> {
  const { payload } = event
  if (payload.confirmedBy !== 'staff') return
  await textBooker(tx, scope, payload, hotel => `Booking ${payload.bookingNo} at ${hotel} is confirmed: ${payload.checkIn} to ${payload.checkOut}.`)
}

/** `booking.cancelled` → the booker learns it by text message when the hotel cancelled it (an agency releasing its own hold knows). */
export async function notifyBookingCancelled(tx: Db, scope: OrganizationScope, event: BookingCancelledV1): Promise<void> {
  const { payload } = event
  if (payload.cancelledBy !== 'staff') return
  await textBooker(tx, scope, payload, hotel => `Booking ${payload.bookingNo} at ${hotel} (${payload.checkIn} to ${payload.checkOut}) was cancelled by the hotel.`)
}
