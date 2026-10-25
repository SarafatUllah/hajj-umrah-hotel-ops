/** Who books (v7 §6): an agency (portal, or staff on its behalf) or an individual customer (public site). */
export const BOOKER_TYPES = ['AGENCY', 'INDIVIDUAL'] as const
export type BookerType = typeof BOOKER_TYPES[number]

/** FAMILY: one total, rooms only for this booking. GROUP: men and women always in separate rooms (v7 §5–6). */
export const BOOKING_TYPES = ['FAMILY', 'GROUP'] as const
export type BookingType = typeof BOOKING_TYPES[number]

/** Booking lifecycle (v7 §7). */
export const BOOKING_STATUSES = ['HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE', 'COMPLETED', 'CANCELLED', 'EXPIRED'] as const
export type BookingStatus = typeof BOOKING_STATUSES[number]

/** Not confirmed yet: seats are held until `hold_expires_at` (10 minutes for HELD, 24 hours for REQUESTED by default). */
export const PENDING_BOOKING_STATUSES = ['HELD', 'REQUESTED'] as const satisfies readonly BookingStatus[]

/** Confirmed at some point and not cancelled: has a receipt, never a hold expiry. */
export const CONFIRMED_BOOKING_STATUSES = ['CONFIRMED', 'IN_HOUSE', 'COMPLETED'] as const satisfies readonly BookingStatus[]

/** Statuses whose room claims occupy seats and fall under the one-owner / one-occupancy constraints (v7 §16). */
export const SEAT_HOLDING_STATUSES = ['HELD', 'REQUESTED', 'CONFIRMED', 'IN_HOUSE'] as const satisfies readonly BookingStatus[]

/** A room claim follows its booking, or is RELEASED on its own when a change (room move, date change) drops it. */
export const BOOKING_ROOM_STATUSES = [...BOOKING_STATUSES, 'RELEASED'] as const
export type BookingRoomStatus = typeof BOOKING_ROOM_STATUSES[number]

/** Who a room holds on a night (one occupancy per room and night, v7 §16). */
export const OCCUPANCIES = ['MALE', 'FEMALE', 'FAMILY'] as const
export type Occupancy = typeof OCCUPANCIES[number]

export const GENDERS = ['MALE', 'FEMALE'] as const
export type Gender = typeof GENDERS[number]

/** From the date of birth on the check-in day (v7 §7): CHILD < 10 years (admin setting), INFANT < 2 (no seat). */
export const AGE_GROUPS = ['ADULT', 'CHILD', 'INFANT'] as const
export type AgeGroup = typeof AGE_GROUPS[number]

/** Which parent's rooms a GROUP booking's children share (default: the mother's). */
export const CHILD_SIDES = ['MOTHER', 'FATHER'] as const
export type ChildSide = typeof CHILD_SIDES[number]

/** Per-pilgrim slot lifecycle (v7 §7). */
export const GUEST_STATUSES = ['PENDING_DETAILS', 'READY', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW', 'REMOVED'] as const
export type GuestStatus = typeof GUEST_STATUSES[number]
/** Pilgrims still to come (details may be missing): the ones whose details anyone may enter, who may be removed or not come. */
export const GUEST_TO_COME_STATUSES = ['PENDING_DETAILS', 'READY'] as const satisfies readonly GuestStatus[]

/** What `booking_change` records (v7 §12). Deliberately no DB enum: later phases add kinds without a migration. */
export const BOOKING_CHANGE_KINDS = [
  'CREATED',
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
  'GUEST_ADDED',
  'GUEST_REMOVED',
  'DATES_CHANGED',
  'ROOM_MOVED',
  'NO_SHOW',
  'EARLY_CHECKOUT',
  'CHECKED_IN',
  'CHECKED_OUT',
  'DETAILS_UPDATED',
] as const
export type BookingChangeKind = typeof BOOKING_CHANGE_KINDS[number]

/** Housekeeping work created by bookings (v7 §11: "room 412: put 1 extra bed before the 15th"). */
export const HOTEL_TASK_KINDS = ['EXTRA_BED_SETUP', 'EXTRA_BED_REMOVAL'] as const
export type HotelTaskKind = typeof HOTEL_TASK_KINDS[number]
export const HOTEL_TASK_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type HotelTaskStatus = typeof HOTEL_TASK_STATUSES[number]

/** Human reference numbers, counted per organization and calendar year (`Q-2027-0001`, `B-2027-0088`). */
export const DOCUMENT_SEQUENCE_KINDS = ['QUOTE', 'BOOKING'] as const
export type DocumentSequenceKind = typeof DOCUMENT_SEQUENCE_KINDS[number]
