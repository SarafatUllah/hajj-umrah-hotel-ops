/**
 * Domain events (Phase 2a ticket 7): facts other parts of the system react to AFTER the change committed — side
 * effects only (messages, other modules' bookkeeping). A rule that must hold at once uses a direct public-service
 * call in the same transaction instead. Every event is versioned: a version never loses or changes a field; a new
 * shape is a new version, and handlers accept the versions they know.
 */
export interface EventEnvelope<Type extends string, Version extends number, Payload> {
  type: Type
  version: Version
  /** Unique per event; handlers are idempotent per (event id, handler). */
  eventId: string
  /** ISO timestamp of the change. */
  occurredAt: string
  organizationId: string
  payload: Payload
}

/** Who confirmed the booking: the booker itself (an agency user, a customer) or staff (a request, or on behalf). */
export type ConfirmedByKind = 'agency' | 'customer' | 'staff'

/** A booking was confirmed (v7 §7): a receipt and its QR token exist from now on. */
export type BookingConfirmedV1 = EventEnvelope<'booking.confirmed', 1, {
  bookingId: string
  bookingNo: string
  hotelId: string
  bookerType: 'AGENCY' | 'INDIVIDUAL'
  agencyId: string | null
  customerId: string | null
  checkIn: string
  checkOut: string
  confirmedBy: ConfirmedByKind
}>

/** Who cancelled the booking: the booker itself (an agency releasing its hold, a customer) or staff. */
export type CancelledByKind = ConfirmedByKind

/** A booking was cancelled (v7 §12): its seats are free again. */
export type BookingCancelledV1 = EventEnvelope<'booking.cancelled', 1, {
  bookingId: string
  bookingNo: string
  hotelId: string
  bookerType: 'AGENCY' | 'INDIVIDUAL'
  agencyId: string | null
  customerId: string | null
  checkIn: string
  checkOut: string
  /** The status it was cancelled from (HELD, REQUESTED or CONFIRMED). */
  previousStatus: string
  cancelledBy: CancelledByKind
}>

export type DomainEvent = BookingConfirmedV1 | BookingCancelledV1
export type DomainEventType = DomainEvent['type']
export type DomainEventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>
