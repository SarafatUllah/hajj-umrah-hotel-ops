import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { AGENCY_STATUSES } from '@hajj/contracts/constants/accounts'
import { idColumn, normalizedEmail, oneOf, organizationColumn, timestampColumns } from './columns'

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

/**
 * An individual booker (public site). Signs in with a verified phone number (SMS code, v7 §21) or a verified e-mail
 * address (e-mail code, D-P2-68); the two are never linked, so each is its own account. `phone` is stored only once
 * proven; `email` may also be unproven contact data (`email_verified_at` null), always normalized (`normalizeEmail`).
 * A verified address is unique per organization, as a phone is. A closed account (step 15b) keeps its row for the
 * bookings that name it, without phone, name or e-mail: the number or address is free to sign up again.
 */
export const customer = pgTable('customer', {
  id: idColumn(),
  organizationId: organizationColumn(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
  email: text('email'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
  sessionVersion: integer('session_version').notNull().default(1),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  ...timestampColumns(),
}, t => [
  unique('customer_org_id_unique').on(t.organizationId, t.id),
  unique('customer_org_phone_unique').on(t.organizationId, t.phone),
  // A verified address signs one account in (stored lower-case: case-insensitive); an unproven copy is contact data.
  uniqueIndex('customer_org_verified_email_unique').on(t.organizationId, t.email).where(sql`${t.emailVerifiedAt} is not null`),
  // E.164, as normalized by the API (`+` and 8–15 digits).
  check('customer_phone_check', sql`${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
  check('customer_email_check', normalizedEmail(t.email)),
  check('customer_email_verified_check', sql`${t.emailVerifiedAt} is null or ${t.email} is not null`),
  // An open account signs in with its phone or its verified e-mail; a closed one has neither (nor any e-mail) and signs
  // nobody in.
  check('customer_closed_check', sql`(${t.closedAt} is null) = (${t.phone} is not null or ${t.emailVerifiedAt} is not null) and (${t.closedAt} is null or (not ${t.isActive} and ${t.email} is null))`),
])

/**
 * A one-time code sent to sign a customer up or in: by SMS to a phone (v7 §21: phone OTP before the public site
 * opens) or by e-mail to an address (D-P2-68) — exactly one of the two. Only an HMAC of the code is stored (keyed by
 * the PII lookup key and the challenge id); a challenge expires after a few minutes, allows a few wrong codes, and
 * is consumed once. Purged daily after expiry.
 */
export const otpChallenge = pgTable('otp_challenge', {
  id: idColumn(),
  organizationId: organizationColumn(),
  phone: text('phone'),
  email: text('email'),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('otp_challenge_phone_idx').on(t.organizationId, t.phone, t.createdAt),
  // An address's open codes (a new one closes them); phone codes have no address.
  index('otp_challenge_email_idx').on(t.organizationId, t.email, t.createdAt).where(sql`${t.email} is not null`),
  index('otp_challenge_expiry_idx').on(t.expiresAt),
  check('otp_challenge_destination_check', sql`num_nonnulls(${t.phone}, ${t.email}) = 1`),
  check('otp_challenge_phone_check', sql`${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
  check('otp_challenge_email_check', normalizedEmail(t.email)),
  check('otp_challenge_attempts_check', sql`${t.attempts} >= 0`),
  check('otp_challenge_hash_check', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
])
