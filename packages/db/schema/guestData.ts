import { sql } from 'drizzle-orm'
import { check, date, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { GENDERS } from '@hajj/contracts/constants/booking'
import { PASSPORT_SCAN_METHODS, PASSPORT_SCAN_STATUSES } from '@hajj/contracts/constants/pilgrimData'
import { ACTOR_KINDS } from '@hajj/contracts/constants/principals'
import { booking, bookingGuest } from './booking'
import { idColumn, oneOf, organizationColumn, timestampColumns } from './columns'
import { documentAsset } from './documents'

/**
 * The BOOKER's own copy of one slot's pilgrim details (v7 §16): what the agency, the customer or the
 * reception entered for this booking. An agency reads and edits only its own copies; the backend links the
 * copy to the staff master `pilgrim` by `passport_lookup` (not unique here: two bookers may enter the same
 * passport). Passport number and the free-form extras (address, place of birth, issue data, phone) are
 * encrypted (PII cipher, contexts `booking_guest_detail.passport_no:<booking_guest_id>` / `.details:<booking_guest_id>`:
 * one copy per slot, so the slot id binds the ciphertext to its row and is known before the first insert).
 */
export const bookingGuestDetail = pgTable('booking_guest_detail', {
  id: idColumn(),
  organizationId: organizationColumn(),
  bookingId: uuid('booking_id').notNull(),
  bookingGuestId: uuid('booking_guest_id').notNull(),
  fullName: text('full_name').notNull(),
  gender: text('gender'),
  nationality: text('nationality'),
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  passportNoEncrypted: text('passport_no_encrypted'),
  passportLookup: text('passport_lookup'),
  passportExpiry: date('passport_expiry', { mode: 'string' }),
  detailsEncrypted: text('details_encrypted'),
  enteredByKind: text('entered_by_kind').notNull(),
  enteredById: uuid('entered_by_id'),
  /** Erased by the retention sweep (ticket 4): the personal fields are cleared, the row stays for the slot's history. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
  ...timestampColumns(),
}, t => [
  unique('booking_guest_detail_org_id_unique').on(t.organizationId, t.id),
  // One booker's copy per slot.
  unique('booking_guest_detail_guest_unique').on(t.organizationId, t.bookingGuestId),
  // Target of passport_scan_detail_fk: a scan fills only a copy of its own booking's slot.
  unique('booking_guest_detail_org_booking_guest_id_unique').on(t.organizationId, t.bookingId, t.bookingGuestId, t.id),
  foreignKey({ columns: [t.organizationId, t.bookingId, t.bookingGuestId], foreignColumns: [bookingGuest.organizationId, bookingGuest.bookingId, bookingGuest.id], name: 'booking_guest_detail_guest_fk' }),
  index('booking_guest_detail_lookup_idx').on(t.organizationId, t.passportLookup),
  check('booking_guest_detail_gender_check', sql`${t.gender} is null or ${oneOf(t.gender, GENDERS)}`),
  check('booking_guest_detail_nationality_check', sql`${t.nationality} is null or ${t.nationality} ~ '^[A-Z]{3}$'`),
  check('booking_guest_detail_passport_check', sql`(${t.passportNoEncrypted} is null) = (${t.passportLookup} is null)`),
  check('booking_guest_detail_lookup_check', sql`${t.passportLookup} is null or ${t.passportLookup} ~ '^[0-9a-f]{64}$'`),
  check('booking_guest_detail_entered_by_check', oneOf(t.enteredByKind, ACTOR_KINDS)),
])

/**
 * One uploaded passport image and what was read from it (v7 §13). Ticket 1: a scan belongs to the
 * booking and the slot it was placed into, and — once a person confirms the review form — to the booker's
 * copy it filled; it never points at the staff master. The image itself is an encrypted `document_asset`;
 * the extracted fields are encrypted (`passport_scan.extracted:<id>`); `confidence` holds per-field scores
 * only. `delete_after` drives the retention job (v7 §15, ticket 4).
 */
export const passportScan = pgTable('passport_scan', {
  id: idColumn(),
  organizationId: organizationColumn(),
  bookingId: uuid('booking_id').notNull(),
  bookingGuestId: uuid('booking_guest_id'),
  bookingGuestDetailId: uuid('booking_guest_detail_id'),
  documentId: uuid('document_id').notNull(),
  method: text('method'),
  status: text('status').notNull().default('QUEUED'),
  extractedEncrypted: text('extracted_encrypted'),
  confidence: jsonb('confidence'),
  failureReason: text('failure_reason'),
  uploadedByKind: text('uploaded_by_kind').notNull(),
  uploadedById: uuid('uploaded_by_id'),
  reviewedByKind: text('reviewed_by_kind'),
  reviewedById: uuid('reviewed_by_id'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  deleteAfter: date('delete_after', { mode: 'string' }),
  ...timestampColumns(),
}, t => [
  unique('passport_scan_org_id_unique').on(t.organizationId, t.id),
  unique('passport_scan_document_unique').on(t.organizationId, t.documentId),
  foreignKey({ columns: [t.organizationId, t.bookingId], foreignColumns: [booking.organizationId, booking.id], name: 'passport_scan_booking_fk' }),
  foreignKey({ columns: [t.organizationId, t.bookingId, t.bookingGuestId], foreignColumns: [bookingGuest.organizationId, bookingGuest.bookingId, bookingGuest.id], name: 'passport_scan_guest_fk' }),
  foreignKey({ columns: [t.organizationId, t.bookingId, t.bookingGuestId, t.bookingGuestDetailId], foreignColumns: [bookingGuestDetail.organizationId, bookingGuestDetail.bookingId, bookingGuestDetail.bookingGuestId, bookingGuestDetail.id], name: 'passport_scan_detail_fk' }),
  foreignKey({ columns: [t.organizationId, t.documentId], foreignColumns: [documentAsset.organizationId, documentAsset.id], name: 'passport_scan_document_fk' }),
  // Also serves a booking's scans and its slot's (the prefixes).
  index('passport_scan_detail_idx').on(t.organizationId, t.bookingId, t.bookingGuestId, t.bookingGuestDetailId),
  // The retention sweep runs per organization.
  index('passport_scan_retention_idx').on(t.organizationId, t.deleteAfter),
  check('passport_scan_method_check', sql`${t.method} is null or ${oneOf(t.method, PASSPORT_SCAN_METHODS)}`),
  check('passport_scan_status_check', oneOf(t.status, PASSPORT_SCAN_STATUSES)),
  check('passport_scan_uploaded_by_check', oneOf(t.uploadedByKind, ACTOR_KINDS)),
  check('passport_scan_reviewed_by_check', sql`${t.reviewedByKind} is null or ${oneOf(t.reviewedByKind, ACTOR_KINDS)}`),
  // A filled copy is always a copy of the scan's own slot (the composite FK above needs the slot).
  check('passport_scan_detail_slot_check', sql`${t.bookingGuestDetailId} is null or ${t.bookingGuestId} is not null`),
  check('passport_scan_confirmed_check', sql`${t.status} <> 'CONFIRMED' or (${t.bookingGuestDetailId} is not null and ${t.reviewedAt} is not null)`),
])
