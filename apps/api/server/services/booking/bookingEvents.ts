import type { ActorKind } from '@hajj/contracts/constants/principals'
import type { BookingConfirmedV1, ConfirmedByKind } from '@hajj/contracts/events/domainEvents'
import { newEvent } from '../../events/bus'
import { isSmsEnabled, useSmsSender } from '../../notifications/sms'
import { tenantRepos } from '../../repositories'
import type { BookingRow } from '../../repositories/booking'
import type { OrganizationScope } from '../../security/scope'
import { findBookerPhone } from '../accounts'

type Db = Parameters<typeof tenantRepos>[0]

/** The confirmer as the event names it (the system never confirms). */
const confirmedByOf = (actor: ActorKind): ConfirmedByKind => (actor === 'agency' || actor === 'customer' ? actor : 'staff')

/** `booking.confirmed` v1 for a booking just confirmed by `actor`. */
export function bookingConfirmedEvent(row: BookingRow, actor: ActorKind, now: Date): BookingConfirmedV1 {
  return newEvent<BookingConfirmedV1>('booking.confirmed', 1, row.organizationId, {
    bookingId: row.id,
    bookingNo: row.bookingNo,
    hotelId: row.hotelId,
    bookerType: row.bookerType as BookingConfirmedV1['payload']['bookerType'],
    agencyId: row.agencyId,
    customerId: row.customerId,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    confirmedBy: confirmedByOf(actor),
  }, now)
}

/**
 * `booking.confirmed` → the booker learns it by text message when someone else confirmed it: a customer whose
 * request staff confirmed (v7 §7 REQUESTED), or an agency whose booking staff made on its behalf. A booker who
 * confirmed it themselves sees it already. Nothing is sent while text messages are not configured; a failed message
 * throws, so the job is retried.
 */
export async function notifyBookingConfirmed(tx: Db, scope: OrganizationScope, event: BookingConfirmedV1): Promise<void> {
  const { payload } = event
  if (payload.confirmedBy !== 'staff' || !isSmsEnabled()) return
  const phone = await findBookerPhone(tx, scope, payload)
  if (!phone) return
  const hotel = await tenantRepos(tx, scope).hotels.findById(payload.hotelId)
  await useSmsSender().send({ to: phone, text: `Booking ${payload.bookingNo} at ${hotel?.name ?? 'the hotel'} is confirmed: ${payload.checkIn} to ${payload.checkOut}.` })
}
