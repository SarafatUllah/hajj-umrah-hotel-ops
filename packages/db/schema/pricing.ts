import { sql } from 'drizzle-orm'
import { boolean, check, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { BOOKING_TYPES, CHILD_SIDES } from '@hajj/contracts/constants/booking'
import { PRICE_TYPES, PRICE_UNITS, PRICED_QUOTE_STATUSES, QUOTE_STATUSES } from '@hajj/contracts/constants/pricing'
import { agency, agencyUser } from './accounts'
import { idColumn, oneOf, organizationColumn, timestampColumns } from './columns'
import { hotel } from './hotel'
import { roomType } from './inventory'
import { organization } from './tenancy'

/*
 * Phase 2a pricing and booking rules (v7 §8, §10, §11, §15). Money is always integer halalas
 * (1 SAR = 100). Seasons are inclusive night ranges `[start_date, end_date]`, like `capacity_period`;
 * their no-overlap exclusion constraints are appended by hand to the migration (Drizzle has no EXCLUDE).
 */

/** Public price, or the optional default price for every approved agency, per hotel, room type and season. */
export const rate = pgTable('rate', {
  id: idColumn(),
  organizationId: organizationColumn(),
  hotelId: uuid('hotel_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  priceType: text('price_type').notNull(),
  unit: text('unit').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  amountHalalas: integer('amount_halalas').notNull(),
  vatIncluded: boolean('vat_included').notNull(),
  createdBy: uuid('created_by'),
  ...timestampColumns(),
}, t => [
  unique('rate_org_hotel_id_unique').on(t.organizationId, t.hotelId, t.id),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'rate_hotel_fk' }),
  foreignKey({ columns: [t.organizationId, t.roomTypeId], foreignColumns: [roomType.organizationId, roomType.id], name: 'rate_room_type_fk' }),
  index('rate_hotel_type_idx').on(t.organizationId, t.hotelId, t.roomTypeId),
  index('rate_room_type_idx').on(t.organizationId, t.roomTypeId),
  check('rate_price_type_check', oneOf(t.priceType, PRICE_TYPES)),
  check('rate_unit_check', oneOf(t.unit, PRICE_UNITS)),
  check('rate_range_check', sql`${t.startDate} <= ${t.endDate}`),
  check('rate_amount_check', sql`${t.amountHalalas} >= 0`),
])

/**
 * A WhatsApp price quote for one agency, hotel, stay and head count (v7 §8). A quote never holds rooms.
 * Which booking used it is recorded on the booking (`booking.quote_id`, unique among bookings that did not
 * expire), so a quote is used by at most one live booking and a cancelled booking keeps it used.
 */
export const priceQuote = pgTable('price_quote', {
  id: idColumn(),
  organizationId: organizationColumn(),
  refNo: text('ref_no').notNull(),
  agencyId: uuid('agency_id').notNull(),
  hotelId: uuid('hotel_id').notNull(),
  bookingType: text('booking_type').notNull(),
  checkIn: date('check_in', { mode: 'string' }).notNull(),
  checkOut: date('check_out', { mode: 'string' }).notNull(),
  maleCount: integer('male_count').notNull().default(0),
  femaleCount: integer('female_count').notNull().default(0),
  totalCount: integer('total_count').notNull(),
  status: text('status').notNull().default('REQUESTED'),
  amountHalalas: integer('amount_halalas'),
  unit: text('unit'),
  vatIncluded: boolean('vat_included'),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  requestedByAgencyUserId: uuid('requested_by_agency_user_id'),
  requestedByUserId: uuid('requested_by_user_id'),
  offeredBy: uuid('offered_by'),
  offeredAt: timestamp('offered_at', { withTimezone: true }),
  notes: text('notes'),
  ...timestampColumns(),
}, t => [
  unique('price_quote_org_id_unique').on(t.organizationId, t.id),
  unique('price_quote_org_ref_unique').on(t.organizationId, t.refNo),
  // Target of booking_quote_fk: a booking uses only its own agency's quote for its own hotel.
  unique('price_quote_org_id_agency_hotel_unique').on(t.organizationId, t.id, t.agencyId, t.hotelId),
  foreignKey({ columns: [t.organizationId, t.agencyId], foreignColumns: [agency.organizationId, agency.id], name: 'price_quote_agency_fk' }),
  foreignKey({ columns: [t.organizationId, t.agencyId, t.requestedByAgencyUserId], foreignColumns: [agencyUser.organizationId, agencyUser.agencyId, agencyUser.id], name: 'price_quote_requested_by_agency_user_fk' }),
  index('price_quote_requested_by_idx').on(t.organizationId, t.agencyId, t.requestedByAgencyUserId),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'price_quote_hotel_fk' }),
  index('price_quote_agency_idx').on(t.organizationId, t.agencyId, t.createdAt),
  index('price_quote_hotel_idx').on(t.organizationId, t.hotelId),
  check('price_quote_type_check', oneOf(t.bookingType, BOOKING_TYPES)),
  check('price_quote_status_check', oneOf(t.status, QUOTE_STATUSES)),
  check('price_quote_unit_check', sql`${t.unit} is null or ${oneOf(t.unit, PRICE_UNITS)}`),
  check('price_quote_stay_check', sql`${t.checkIn} < ${t.checkOut}`),
  check('price_quote_counts_check', sql`${t.maleCount} >= 0 and ${t.femaleCount} >= 0 and ${t.totalCount} >= 1`),
  // GROUP quotes are per side (children counted on their side); FAMILY quotes carry only the total.
  check('price_quote_group_counts_check', sql`case when ${t.bookingType} = 'GROUP' then ${t.maleCount} + ${t.femaleCount} = ${t.totalCount} else ${t.maleCount} = 0 and ${t.femaleCount} = 0 end`),
  // An offered (or used) quote always carries its price and validity.
  check('price_quote_offer_check', sql`not ${oneOf(t.status, PRICED_QUOTE_STATUSES)} or (${t.amountHalalas} is not null and ${t.unit} is not null and ${t.vatIncluded} is not null and ${t.validUntil} is not null and ${t.offeredAt} is not null)`),
  check('price_quote_amount_check', sql`${t.amountHalalas} is null or ${t.amountHalalas} >= 0`),
])

/**
 * The most persons an agency may hold in a hotel per night during a season (v7 §10: a fixed number, not a
 * percentage). `agency_id` NULL = the default for every agency; an agency's own row wins over the default.
 * A night covered by no row has no quota (§23 Q19).
 */
export const agencyQuota = pgTable('agency_quota', {
  id: idColumn(),
  organizationId: organizationColumn(),
  hotelId: uuid('hotel_id').notNull(),
  agencyId: uuid('agency_id'),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  maxPersons: integer('max_persons').notNull(),
  ...timestampColumns(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'agency_quota_hotel_fk' }),
  foreignKey({ columns: [t.organizationId, t.agencyId], foreignColumns: [agency.organizationId, agency.id], name: 'agency_quota_agency_fk' }),
  index('agency_quota_hotel_idx').on(t.organizationId, t.hotelId),
  index('agency_quota_agency_idx').on(t.organizationId, t.agencyId),
  check('agency_quota_range_check', sql`${t.startDate} <= ${t.endDate}`),
  check('agency_quota_max_check', sql`${t.maxPersons} >= 0`),
])

/**
 * Room-mix rule (v7 §5 rule 10, §15): for a group (per gender, §23 Q11) of `group_min`..`group_max` persons
 * (`group_max` NULL = no upper bound), at most `max_rooms` rooms with `min_seats` or more usable seats.
 */
export const allocationRule = pgTable('allocation_rule', {
  id: idColumn(),
  organizationId: organizationColumn(),
  hotelId: uuid('hotel_id').notNull(),
  groupMin: integer('group_min').notNull(),
  groupMax: integer('group_max'),
  minSeats: integer('min_seats').notNull().default(5),
  maxRooms: integer('max_rooms').notNull(),
  ...timestampColumns(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'allocation_rule_hotel_fk' }),
  index('allocation_rule_hotel_idx').on(t.organizationId, t.hotelId),
  check('allocation_rule_group_check', sql`${t.groupMin} >= 1 and (${t.groupMax} is null or ${t.groupMax} >= ${t.groupMin})`),
  check('allocation_rule_seats_check', sql`${t.minSeats} between 1 and 30`),
  check('allocation_rule_rooms_check', sql`${t.maxRooms} >= 0`),
])

/** Extra beds (v7 §11): where, how many and at what price — one policy per hotel and room type. */
export const extraBedPolicy = pgTable('extra_bed_policy', {
  id: idColumn(),
  organizationId: organizationColumn(),
  hotelId: uuid('hotel_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  maxPerRoom: integer('max_per_room').notNull(),
  maxPerBooking: integer('max_per_booking').notNull(),
  amountHalalas: integer('amount_halalas').notNull(),
  vatIncluded: boolean('vat_included').notNull(),
  // §23 Q15: by default no extra bed in a room whose capacity is seasonally overridden that night.
  allowInOverrideSeason: boolean('allow_in_override_season').notNull().default(false),
  ...timestampColumns(),
}, t => [
  unique('extra_bed_policy_hotel_type_unique').on(t.organizationId, t.hotelId, t.roomTypeId),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'extra_bed_policy_hotel_fk' }),
  foreignKey({ columns: [t.organizationId, t.roomTypeId], foreignColumns: [roomType.organizationId, roomType.id], name: 'extra_bed_policy_room_type_fk' }),
  index('extra_bed_policy_room_type_idx').on(t.organizationId, t.roomTypeId),
  check('extra_bed_policy_limits_check', sql`${t.maxPerRoom} between 0 and 5 and ${t.maxPerBooking} >= 0`),
  check('extra_bed_policy_amount_check', sql`${t.amountHalalas} >= 0`),
])

/**
 * Organization-wide booking settings (v7 §15); one row per organization, every column defaulted. A missing
 * row means "all defaults": the first read creates it from the column defaults (BookingSettingRepository.ensure).
 */
export const bookingSetting = pgTable('booking_setting', {
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  holdMinutes: integer('hold_minutes').notNull().default(10),
  requestHours: integer('request_hours').notNull().default(24),
  quoteValidityHours: integer('quote_validity_hours').notNull().default(48),
  individualMaxRooms: integer('individual_max_rooms').notNull().default(5),
  individualMaxOpenRequests: integer('individual_max_open_requests').notNull().default(1),
  childAgeLimit: integer('child_age_limit').notNull().default(10),
  infantAgeLimit: integer('infant_age_limit').notNull().default(2),
  childDefaultSide: text('child_default_side').notNull().default('MOTHER'),
  passportMinValidityMonths: integer('passport_min_validity_months').notNull().default(6),
  detailsReminderDays: integer('details_reminder_days').notNull().default(7),
  passportImageRetentionMonths: integer('passport_image_retention_months').notNull().default(12),
  /** The organization's consent to send passport images to the external AI reader (v7 §13 fallback; PDPL transfer). */
  passportAiAllowed: boolean('passport_ai_allowed').notNull().default(false),
  /** Bookers' copies of pilgrims' details (and unused staff masters) are erased this long after check-out (ticket 4, PDPL). */
  guestDataRetentionMonths: integer('guest_data_retention_months').notNull().default(24),
  whatsappNumber: text('whatsapp_number'),
  whatsappTemplate: text('whatsapp_template'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
}, t => [
  primaryKey({ columns: [t.organizationId] }),
  check('booking_setting_hold_check', sql`${t.holdMinutes} between 1 and 120`),
  check('booking_setting_request_check', sql`${t.requestHours} between 1 and 168`),
  check('booking_setting_quote_check', sql`${t.quoteValidityHours} between 1 and 720`),
  check('booking_setting_individual_check', sql`${t.individualMaxRooms} between 1 and 50 and ${t.individualMaxOpenRequests} between 1 and 10`),
  check('booking_setting_age_check', sql`${t.infantAgeLimit} between 1 and 5 and ${t.childAgeLimit} between ${t.infantAgeLimit} and 18`),
  check('booking_setting_child_side_check', oneOf(t.childDefaultSide, CHILD_SIDES)),
  check('booking_setting_passport_check', sql`${t.passportMinValidityMonths} between 0 and 24 and ${t.passportImageRetentionMonths} between 1 and 120`),
  check('booking_setting_reminder_check', sql`${t.detailsReminderDays} between 0 and 60`),
  check('booking_setting_guest_retention_check', sql`${t.guestDataRetentionMonths} between 1 and 120`),
  check('booking_setting_whatsapp_check', sql`${t.whatsappNumber} is null or ${t.whatsappNumber} ~ '^[1-9][0-9]{7,14}$'`),
])
