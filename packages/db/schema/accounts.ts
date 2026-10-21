import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { AGENCY_STATUSES } from '@hajj/contracts/constants/accounts'
import { idColumn, oneOf, organizationColumn, timestampColumns } from './columns'

/**
 * Phase 2a (v7 §16): agencies and individual customers live INSIDE the operator's organization (one
 * operator, §23 Q1). Each has its own sign-in principal (`agency_user`, `customer`), never an `app_user`.
 */
export const agency = pgTable('agency', {
  id: idColumn(),
  organizationId: organizationColumn(),
  name: text('name').notNull(),
  licenseNo: text('license_no').notNull(),
  contactName: text('contact_name').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  whatsappNumber: text('whatsapp_number'),
  address: text('address'),
  status: text('status').notNull().default('PENDING'),
  statusReason: text('status_reason'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: uuid('approved_by'),
  ...timestampColumns(),
}, t => [
  unique('agency_org_id_unique').on(t.organizationId, t.id),
  unique('agency_org_license_unique').on(t.organizationId, t.licenseNo),
  check('agency_status_check', oneOf(t.status, AGENCY_STATUSES)),
  // Approval is a recorded act: an APPROVED agency always has its approval time (kept after a suspension).
  check('agency_approval_check', sql`${t.status} <> 'APPROVED' or ${t.approvedAt} is not null`),
  check('agency_name_check', sql`char_length(btrim(${t.name})) between 1 and 200`),
])

/** An agency's own sign-in (agency portal). Sees only its own agency's bookings (AgencyScope). */
export const agencyUser = pgTable('agency_user', {
  id: idColumn(),
  organizationId: organizationColumn(),
  agencyId: uuid('agency_id').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  isActive: boolean('is_active').notNull().default(true),
  sessionVersion: integer('session_version').notNull().default(1),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestampColumns(),
}, t => [
  unique('agency_user_org_id_unique').on(t.organizationId, t.id),
  unique('agency_user_org_agency_id_unique').on(t.organizationId, t.agencyId, t.id),
  uniqueIndex('agency_user_org_email_unique').on(t.organizationId, t.email),
  foreignKey({ columns: [t.organizationId, t.agencyId], foreignColumns: [agency.organizationId, agency.id], name: 'agency_user_agency_fk' }),
  index('agency_user_agency_idx').on(t.organizationId, t.agencyId),
])

/** An individual booker (public site): identified by a verified phone number (OTP, v7 §21), e-mail optional. */
export const customer = pgTable('customer', {
  id: idColumn(),
  organizationId: organizationColumn(),
  fullName: text('full_name').notNull(),
  phone: text('phone').notNull(),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  email: text('email'),
  isActive: boolean('is_active').notNull().default(true),
  sessionVersion: integer('session_version').notNull().default(1),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestampColumns(),
}, t => [
  unique('customer_org_id_unique').on(t.organizationId, t.id),
  unique('customer_org_phone_unique').on(t.organizationId, t.phone),
  // E.164, as normalized by the API (`+` and 8–15 digits).
  check('customer_phone_check', sql`${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
])
