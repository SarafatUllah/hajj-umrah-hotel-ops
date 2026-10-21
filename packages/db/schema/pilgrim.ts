import { sql } from 'drizzle-orm'
import { check, date, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { GENDERS } from '@hajj/contracts/constants/booking'
import { PII_SUBJECT_TYPES } from '@hajj/contracts/constants/pilgrimData'
import { ACTOR_KINDS } from '@hajj/contracts/constants/principals'
import { idColumn, oneOf, organizationColumn, timestampColumns } from './columns'

/**
 * The staff-only MASTER identity of a pilgrim (v7 §16): one row per passport per organization, linked
 * silently by the backend from the bookers' own copies (`booking_guest_detail`) via `passport_lookup`.
 * No agency or customer ever reads it. The passport number is encrypted (PII cipher, context
 * `pilgrim.passport_no:<passport_lookup>`, unique per organization); `passport_lookup` = HMAC(lookup key,
 * nationality + normalized number).
 * Name, gender, nationality and dates stay in clear text: the calendar, check-in and age rules need them,
 * and they never leave the access-controlled tables (logs keep only ids).
 */
export const pilgrim = pgTable('pilgrim', {
  id: idColumn(),
  organizationId: organizationColumn(),
  fullName: text('full_name').notNull(),
  gender: text('gender').notNull(),
  nationality: text('nationality').notNull(),
  dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
  passportNoEncrypted: text('passport_no_encrypted').notNull(),
  passportLookup: text('passport_lookup').notNull(),
  passportExpiry: date('passport_expiry', { mode: 'string' }).notNull(),
  ...timestampColumns(),
}, t => [
  unique('pilgrim_org_id_unique').on(t.organizationId, t.id),
  unique('pilgrim_org_passport_lookup_unique').on(t.organizationId, t.passportLookup),
  check('pilgrim_gender_check', oneOf(t.gender, GENDERS)),
  // ICAO 9303 three-letter code (MRZ), e.g. BGD, PAK, IDN.
  check('pilgrim_nationality_check', sql`${t.nationality} ~ '^[A-Z]{3}$'`),
  check('pilgrim_lookup_check', sql`${t.passportLookup} ~ '^[0-9a-f]{64}$'`),
])

/**
 * Who read which personal data, when (v7 §13 PDPL): `audit_log` records changes only. Append-only (a
 * trigger refuses UPDATE). `fields` names what was shown (e.g. `passport_no`, `image`), never the values.
 */
export const piiAccessLog = pgTable('pii_access_log', {
  id: idColumn(),
  organizationId: organizationColumn(),
  actorKind: text('actor_kind').notNull(),
  actorId: uuid('actor_id'),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  fields: text('fields').array().notNull(),
  purpose: text('purpose'),
  accessedAt: timestamp('accessed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('pii_access_log_subject_idx').on(t.organizationId, t.subjectType, t.subjectId, t.accessedAt),
  index('pii_access_log_actor_idx').on(t.organizationId, t.actorKind, t.actorId, t.accessedAt),
  check('pii_access_log_actor_check', oneOf(t.actorKind, ACTOR_KINDS)),
  check('pii_access_log_subject_check', oneOf(t.subjectType, PII_SUBJECT_TYPES)),
])
