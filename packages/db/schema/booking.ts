import { sql } from 'drizzle-orm'
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { AGE_GROUPS, BOOKER_TYPES, BOOKING_ROOM_STATUSES, BOOKING_STATUSES, BOOKING_TYPES, CHILD_SIDES, CONFIRMED_BOOKING_STATUSES, GENDERS, GUEST_STATUSES, HOTEL_TASK_KINDS, HOTEL_TASK_STATUSES, OCCUPANCIES, PENDING_BOOKING_STATUSES, SEAT_HOLDING_STATUSES } from '@hajj/contracts/constants/booking'
import { PRICE_LINE_KINDS, PRICE_SOURCES } from '@hajj/contracts/constants/pricing'
import { ACTOR_KINDS } from '@hajj/contracts/constants/principals'
import { agency, agencyUser, customer } from './accounts'
import { idColumn, oneOf, organizationColumn, timestampColumns } from './columns'
import { hotel } from './hotel'
import { room, roomType } from './inventory'
import { pilgrim } from './pilgrim'
import { priceQuote } from './pricing'

/*
 * Phase 2a booking core (v7 §7, §16). Stays are `[check_in, check_out)`: the nights from check-in up to the
 * night before check-out. Range constraints build `daterange(check_in, check_out, '[)')`. Appended by hand to
 * migration 0009 (Drizzle has no builder for them): the exclusion constraints, the status-sync and
 * containment triggers, and the seat-counting function `room_night_occupancy(org, hotel, from, to, rooms)` (0018 adds
 * an optional booking it leaves out, for a date change).
 */

/**
 * One booking. Counts: GROUP — men, women and children under the child age (all take seats; children sit
 * on `child_side`), FAMILY — only `total_count`; infants under 2 take no seat and are counted apart.
 */
export const booking = pgTable('booking', {
  id: idColumn(),
  organizationId: organizationColumn(),
  hotelId: uuid('hotel_id').notNull(),
  bookingNo: text('booking_no').notNull(),
  bookerType: text('booker_type').notNull(),
  agencyId: uuid('agency_id'),
  customerId: uuid('customer_id'),
  createdByUserId: uuid('created_by_user_id'),
  createdByAgencyUserId: uuid('created_by_agency_user_id'),
  bookingType: text('booking_type').notNull(),
  checkIn: date('check_in', { mode: 'string' }).notNull(),
  checkOut: date('check_out', { mode: 'string' }).notNull(),
  maleCount: integer('male_count').notNull().default(0),
  femaleCount: integer('female_count').notNull().default(0),
  childCount: integer('child_count').notNull().default(0),
  infantCount: integer('infant_count').notNull().default(0),
  totalCount: integer('total_count').notNull(),
  childSide: text('child_side'),
  priceSource: text('price_source').notNull(),
  quoteId: uuid('quote_id'),
  status: text('status').notNull(),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmedBy: uuid('confirmed_by'),
  // Random token printed as the receipt QR (v7 §21): never the booking id or personal data.
  receiptToken: text('receipt_token'),
  /** When the booker was reminded to complete the pilgrims' details (v7 §15 `detailsReminderDays`); once per booking. */
  detailsRemindedAt: timestamp('details_reminded_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: uuid('cancelled_by'),
  cancelReason: text('cancel_reason'),
  notes: text('notes'),
  ...timestampColumns(),
}, t => [
  unique('booking_org_id_unique').on(t.organizationId, t.id),
  unique('booking_org_hotel_id_unique').on(t.organizationId, t.hotelId, t.id),
  // Target of booking_room's owner-agency FK: a room claim's owner agency is always the booking's agency.
  unique('booking_org_id_agency_unique').on(t.organizationId, t.id, t.agencyId),
  unique('booking_org_no_unique').on(t.organizationId, t.bookingNo),
  unique('booking_receipt_token_unique').on(t.receiptToken),
  // A quote serves one live booking; an EXPIRED hold gives it back, a cancelled booking does not (v7 §12).
  uniqueIndex('booking_quote_once').on(t.organizationId, t.quoteId).where(sql`${t.quoteId} is not null and ${t.status} <> 'EXPIRED'`),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'booking_hotel_fk' }),
  foreignKey({ columns: [t.organizationId, t.agencyId], foreignColumns: [agency.organizationId, agency.id], name: 'booking_agency_fk' }),
  foreignKey({ columns: [t.organizationId, t.customerId], foreignColumns: [customer.organizationId, customer.id], name: 'booking_customer_fk' }),
  // A booking may use only ITS agency's quote for ITS hotel (the quote's dates and counts are checked by the service).
  foreignKey({ columns: [t.organizationId, t.quoteId, t.agencyId, t.hotelId], foreignColumns: [priceQuote.organizationId, priceQuote.id, priceQuote.agencyId, priceQuote.hotelId], name: 'booking_quote_fk' }),
  foreignKey({ columns: [t.organizationId, t.agencyId, t.createdByAgencyUserId], foreignColumns: [agencyUser.organizationId, agencyUser.agencyId, agencyUser.id], name: 'booking_created_by_agency_user_fk' }),
  index('booking_hotel_stay_idx').on(t.organizationId, t.hotelId, t.checkIn, t.checkOut),
  index('booking_agency_idx').on(t.organizationId, t.agencyId),
  // The quota count (v7 §10) reads one agency's live bookings in one hotel under the hold's quota lock.
  index('booking_agency_live_idx').on(t.organizationId, t.agencyId, t.hotelId, t.checkIn).where(oneOf(t.status, SEAT_HOLDING_STATUSES)),
  index('booking_customer_idx').on(t.organizationId, t.customerId),
  // Covers booking_quote_fk (the partial unique index booking_quote_once cannot serve a foreign-key check).
  index('booking_quote_idx').on(t.organizationId, t.quoteId, t.agencyId, t.hotelId),
  index('booking_created_by_agency_user_idx').on(t.organizationId, t.agencyId, t.createdByAgencyUserId),
  // The hold sweep (every minute): pending bookings by expiry.
  index('booking_pending_expiry_idx').on(t.holdExpiresAt).where(oneOf(t.status, PENDING_BOOKING_STATUSES)),
  // The staff list, newest first (all hotels, or one), read backwards with its keyset.
  index('booking_created_idx').on(t.organizationId, t.createdAt, t.id),
  index('booking_hotel_created_idx').on(t.organizationId, t.hotelId, t.createdAt, t.id),
  // The daily jobs: the details reminder (confirmed, not yet reminded, by arrival) and the erasure (by departure).
  index('booking_details_reminder_idx').on(t.organizationId, t.checkIn, t.id).where(sql`${t.status} = 'CONFIRMED' and ${t.detailsRemindedAt} is null`),
  index('booking_check_out_idx').on(t.organizationId, t.checkOut, t.id),
  check('booking_booker_type_check', oneOf(t.bookerType, BOOKER_TYPES)),
  check('booking_type_check', oneOf(t.bookingType, BOOKING_TYPES)),
  check('booking_status_check', oneOf(t.status, BOOKING_STATUSES)),
  check('booking_price_source_check', oneOf(t.priceSource, PRICE_SOURCES)),
  check('booking_child_side_enum_check', sql`${t.childSide} is null or ${oneOf(t.childSide, CHILD_SIDES)}`),
  check('booking_booker_check', sql`(${t.bookerType} = 'AGENCY' and ${t.agencyId} is not null and ${t.customerId} is null) or (${t.bookerType} = 'INDIVIDUAL' and ${t.customerId} is not null and ${t.agencyId} is null)`),
  check('booking_stay_check', sql`${t.checkIn} < ${t.checkOut}`),
  check('booking_counts_check', sql`${t.maleCount} >= 0 and ${t.femaleCount} >= 0 and ${t.childCount} >= 0 and ${t.infantCount} >= 0 and ${t.totalCount} >= 1`),
  check('booking_group_counts_check', sql`case when ${t.bookingType} = 'GROUP' then ${t.maleCount} + ${t.femaleCount} + ${t.childCount} = ${t.totalCount} else ${t.maleCount} = 0 and ${t.femaleCount} = 0 and ${t.childCount} = 0 end`),
  check('booking_child_side_check', sql`${t.childCount} = 0 or ${t.childSide} is not null`),
  check('booking_quote_source_check', sql`(${t.priceSource} = 'QUOTE') = (${t.quoteId} is not null)`),
  check('booking_quote_agency_check', sql`${t.quoteId} is null or ${t.bookerType} = 'AGENCY'`),
  // Ticket 2: a pending booking always has an expiry, so no NULL can silently release (or keep) its seats;
  // a confirmed one never keeps one (confirming clears it).
  check('booking_hold_expiry_check', sql`not ${oneOf(t.status, PENDING_BOOKING_STATUSES)} or ${t.holdExpiresAt} is not null`),
  check('booking_confirmed_expiry_check', sql`not ${oneOf(t.status, CONFIRMED_BOOKING_STATUSES)} or ${t.holdExpiresAt} is null`),
  // REQUESTED is the individual booker's unpaid request (v7 §7); agencies go HELD → CONFIRMED.
  check('booking_requested_check', sql`${t.status} <> 'REQUESTED' or ${t.bookerType} = 'INDIVIDUAL'`),
  check('booking_confirmed_check', sql`not ${oneOf(t.status, CONFIRMED_BOOKING_STATUSES)} or (${t.confirmedAt} is not null and ${t.receiptToken} is not null)`),
  check('booking_cancelled_check', sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} is not null)`),
])

/**
 * A booking's claim on one room (v7 §16): who owns the room for which nights, as which occupancy. Every
 * booking has its OWN rows, even two bookings of one agency sharing a room ("own room first"), so a
 * cancelled booking never leaves another booking's pilgrims in an unprotected room. Exactly one owner:
 * the agency (GROUP bookings of one agency may share rooms) or the booking itself (FAMILY and individual
 * bookings never share). Appended to the migration: the one-owner, one-occupancy and no-duplicate exclusion
 * constraints; `status` always equals the booking's status unless the claim was RELEASED (a trigger copies
 * every booking status change here, another refuses a mismatch); a claim lies within its booking's stay
 * (deferred constraint trigger, checked at commit).
 */
export const bookingRoom = pgTable('booking_room', {
  id: idColumn(),
  organizationId: organizationColumn(),
  hotelId: uuid('hotel_id').notNull(),
  bookingId: uuid('booking_id').notNull(),
  roomId: uuid('room_id').notNull(),
  ownerAgencyId: uuid('owner_agency_id'),
  ownerBookingId: uuid('owner_booking_id'),
  ownerKey: text('owner_key').notNull().generatedAlwaysAs((): ReturnType<typeof sql> => sql`coalesce('a:' || owner_agency_id::text, 'b:' || owner_booking_id::text)`),
  occupancy: text('occupancy').notNull(),
  checkIn: date('check_in', { mode: 'string' }).notNull(),
  checkOut: date('check_out', { mode: 'string' }).notNull(),
  status: text('status').notNull(),
  extraBeds: integer('extra_beds').notNull().default(0),
  ...timestampColumns(),
}, t => [
  unique('booking_room_org_id_unique').on(t.organizationId, t.id),
  // Target of guest_stay's composite FK: a stay and its room claim always belong to the same booking.
  unique('booking_room_org_booking_id_unique').on(t.organizationId, t.bookingId, t.id),
  foreignKey({ columns: [t.organizationId, t.hotelId, t.bookingId], foreignColumns: [booking.organizationId, booking.hotelId, booking.id], name: 'booking_room_booking_fk' }),
  foreignKey({ columns: [t.organizationId, t.hotelId, t.roomId], foreignColumns: [room.organizationId, room.hotelId, room.id], name: 'booking_room_room_fk' }),
  foreignKey({ columns: [t.organizationId, t.bookingId, t.ownerAgencyId], foreignColumns: [booking.organizationId, booking.id, booking.agencyId], name: 'booking_room_owner_agency_fk' }),
  foreignKey({ columns: [t.organizationId, t.ownerBookingId], foreignColumns: [booking.organizationId, booking.id], name: 'booking_room_owner_booking_fk' }),
  index('booking_room_booking_idx').on(t.organizationId, t.hotelId, t.bookingId),
  index('booking_room_room_idx').on(t.organizationId, t.hotelId, t.roomId, t.checkIn),
  // The seat-counting function and the calendar read a hotel's claims by night range.
  index('booking_room_hotel_stay_idx').on(t.organizationId, t.hotelId, t.checkIn, t.checkOut),
  index('booking_room_owner_agency_idx').on(t.organizationId, t.bookingId, t.ownerAgencyId),
  index('booking_room_owner_booking_idx').on(t.organizationId, t.ownerBookingId),
  check('booking_room_owner_check', sql`num_nonnulls(${t.ownerAgencyId}, ${t.ownerBookingId}) = 1`),
  check('booking_room_owner_self_check', sql`${t.ownerBookingId} is null or ${t.ownerBookingId} = ${t.bookingId}`),
  check('booking_room_occupancy_check', oneOf(t.occupancy, OCCUPANCIES)),
  check('booking_room_status_check', oneOf(t.status, BOOKING_ROOM_STATUSES)),
  check('booking_room_stay_check', sql`${t.checkIn} < ${t.checkOut}`),
  check('booking_room_extra_beds_check', sql`${t.extraBeds} between 0 and 5`),
])

/**
 * One pilgrim slot of a booking (v7 §7): created for every seat (and every infant) at booking time, filled
 * with details later. `pilgrim_id` links the staff master record once matched. An INFANT never takes a seat
 * (the seat count reads `age_group`, so a slot's seat follows its age group automatically).
 */
export const bookingGuest = pgTable('booking_guest', {
  id: idColumn(),
  organizationId: organizationColumn(),
  bookingId: uuid('booking_id').notNull(),
  slotNo: integer('slot_no').notNull(),
  gender: text('gender'),
  ageGroup: text('age_group').notNull(),
  isExtraBed: boolean('is_extra_bed').notNull().default(false),
  pilgrimId: uuid('pilgrim_id'),
  status: text('status').notNull().default('PENDING_DETAILS'),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  checkedInBy: uuid('checked_in_by'),
  checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
  checkedOutBy: uuid('checked_out_by'),
  ...timestampColumns(),
}, t => [
  unique('booking_guest_org_id_unique').on(t.organizationId, t.id),
  unique('booking_guest_org_booking_id_unique').on(t.organizationId, t.bookingId, t.id),
  unique('booking_guest_slot_unique').on(t.organizationId, t.bookingId, t.slotNo),
  foreignKey({ columns: [t.organizationId, t.bookingId], foreignColumns: [booking.organizationId, booking.id], name: 'booking_guest_booking_fk' }),
  foreignKey({ columns: [t.organizationId, t.pilgrimId], foreignColumns: [pilgrim.organizationId, pilgrim.id], name: 'booking_guest_pilgrim_fk' }),
  index('booking_guest_pilgrim_idx').on(t.organizationId, t.pilgrimId),
  check('booking_guest_slot_check', sql`${t.slotNo} >= 1`),
  check('booking_guest_gender_check', sql`${t.gender} is null or ${oneOf(t.gender, GENDERS)}`),
  check('booking_guest_age_group_check', oneOf(t.ageGroup, AGE_GROUPS)),
  check('booking_guest_status_check', oneOf(t.status, GUEST_STATUSES)),
  check('booking_guest_infant_bed_check', sql`not (${t.ageGroup} = 'INFANT' and ${t.isExtraBed})`),
  check('booking_guest_check_in_check', sql`${t.status} not in ('CHECKED_IN', 'CHECKED_OUT') or ${t.checkedInAt} is not null`),
  check('booking_guest_check_out_check', sql`${t.status} <> 'CHECKED_OUT' or ${t.checkedOutAt} is not null`),
])

/**
 * Which pilgrim sleeps in which room on which nights (v7 §16): a room move or an early checkout shortens a
 * row and adds another. Both composite FKs lead with the same booking, so a slot can never sit in another
 * booking's room claim. Appended to the migration: one bed per slot per night (exclusion), and a stay lies
 * within its room claim (deferred constraint trigger). One bed per SLOT: the same person booked twice by two
 * bookers is a staff warning (passport lookup, v7 §13), not a constraint.
 */
export const guestStay = pgTable('guest_stay', {
  id: idColumn(),
  organizationId: organizationColumn(),
  bookingId: uuid('booking_id').notNull(),
  bookingGuestId: uuid('booking_guest_id').notNull(),
  bookingRoomId: uuid('booking_room_id').notNull(),
  checkIn: date('check_in', { mode: 'string' }).notNull(),
  checkOut: date('check_out', { mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.bookingId, t.bookingGuestId], foreignColumns: [bookingGuest.organizationId, bookingGuest.bookingId, bookingGuest.id], name: 'guest_stay_guest_fk' }),
  foreignKey({ columns: [t.organizationId, t.bookingId, t.bookingRoomId], foreignColumns: [bookingRoom.organizationId, bookingRoom.bookingId, bookingRoom.id], name: 'guest_stay_room_fk' }),
  index('guest_stay_guest_idx').on(t.organizationId, t.bookingId, t.bookingGuestId),
  index('guest_stay_room_idx').on(t.organizationId, t.bookingId, t.bookingRoomId),
  index('guest_stay_room_claim_idx').on(t.organizationId, t.bookingRoomId),
  check('guest_stay_range_check', sql`${t.checkIn} < ${t.checkOut}`),
])

/** The frozen per-night price of a booking (v7 §8, §16): quantity × unit amount, never recomputed from rates later. */
export const bookingPriceLine = pgTable('booking_price_line', {
  id: idColumn(),
  organizationId: organizationColumn(),
  bookingId: uuid('booking_id').notNull(),
  night: date('night', { mode: 'string' }).notNull(),
  kind: text('kind').notNull(),
  roomTypeId: uuid('room_type_id'),
  quantity: integer('quantity').notNull(),
  unitAmountHalalas: integer('unit_amount_halalas').notNull(),
  amountHalalas: integer('amount_halalas').notNull(),
  vatIncluded: boolean('vat_included').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.bookingId], foreignColumns: [booking.organizationId, booking.id], name: 'booking_price_line_booking_fk' }),
  foreignKey({ columns: [t.organizationId, t.roomTypeId], foreignColumns: [roomType.organizationId, roomType.id], name: 'booking_price_line_room_type_fk' }),
  unique('booking_price_line_unique').on(t.organizationId, t.bookingId, t.night, t.kind, t.roomTypeId).nullsNotDistinct(),
  index('booking_price_line_room_type_idx').on(t.organizationId, t.roomTypeId),
  check('booking_price_line_kind_check', oneOf(t.kind, PRICE_LINE_KINDS)),
  check('booking_price_line_amount_check', sql`${t.quantity} >= 0 and ${t.unitAmountHalalas} >= 0 and ${t.amountHalalas} = ${t.quantity} * ${t.unitAmountHalalas}`),
])

/**
 * Every change to a booking (v7 §12): what it was, what it became, who, when. Append-only (a trigger
 * refuses UPDATE). `before`/`after` never contain passport data or personal details — only ids and
 * PII-free facts (redacted by the writer; a test scans every row).
 */
export const bookingChange = pgTable('booking_change', {
  id: idColumn(),
  organizationId: organizationColumn(),
  bookingId: uuid('booking_id').notNull(),
  kind: text('kind').notNull(),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  actorKind: text('actor_kind').notNull(),
  actorId: uuid('actor_id'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.bookingId], foreignColumns: [booking.organizationId, booking.id], name: 'booking_change_booking_fk' }),
  index('booking_change_booking_idx').on(t.organizationId, t.bookingId, t.createdAt),
  check('booking_change_actor_check', oneOf(t.actorKind, ACTOR_KINDS)),
])

/** Housekeeping work a booking creates (v7 §11): put an extra bed in, take it out again. */
export const hotelTask = pgTable('hotel_task', {
  id: idColumn(),
  organizationId: organizationColumn(),
  hotelId: uuid('hotel_id').notNull(),
  roomId: uuid('room_id').notNull(),
  bookingId: uuid('booking_id'),
  kind: text('kind').notNull(),
  quantity: integer('quantity').notNull().default(1),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  status: text('status').notNull().default('OPEN'),
  doneAt: timestamp('done_at', { withTimezone: true }),
  doneBy: uuid('done_by'),
  notes: text('notes'),
  ...timestampColumns(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId, t.roomId], foreignColumns: [room.organizationId, room.hotelId, room.id], name: 'hotel_task_room_fk' }),
  foreignKey({ columns: [t.organizationId, t.hotelId, t.bookingId], foreignColumns: [booking.organizationId, booking.hotelId, booking.id], name: 'hotel_task_booking_fk' }),
  index('hotel_task_open_idx').on(t.organizationId, t.hotelId, t.status, t.dueDate),
  index('hotel_task_room_idx').on(t.organizationId, t.hotelId, t.roomId),
  index('hotel_task_booking_idx').on(t.organizationId, t.hotelId, t.bookingId),
  // A booking's tasks without its hotel (erasure, cancellation, a date change).
  index('hotel_task_org_booking_idx').on(t.organizationId, t.bookingId),
  check('hotel_task_kind_check', oneOf(t.kind, HOTEL_TASK_KINDS)),
  check('hotel_task_status_check', oneOf(t.status, HOTEL_TASK_STATUSES)),
  check('hotel_task_quantity_check', sql`${t.quantity} between 1 and 5`),
  check('hotel_task_done_check', sql`(${t.status} = 'DONE') = (${t.doneAt} is not null)`),
])
