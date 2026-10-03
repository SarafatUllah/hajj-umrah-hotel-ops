import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { hotel } from './hotel'
import { organization } from './tenancy'

/**
 * Task 19: document metadata only — the bytes live behind the StorageDriver (server/storage/**) and
 * are addressed by the server-generated `storage_key`. `archived_at` is the only lifecycle column:
 * documents are archived, never deleted by the application. `uploaded_by` carries no FK on purpose
 * (an upload's provenance outlives its user row), like the other actor columns.
 */
export const documentAsset = pgTable('document_asset', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, t => [
  unique('document_asset_org_id_unique').on(t.organizationId, t.id),
  unique('document_asset_storage_key_unique').on(t.storageKey),
  check('document_asset_size_check', sql`${t.sizeBytes} between 1 and 10485760`),
  check('document_asset_mime_check', sql`${t.mimeType} in ('application/pdf', 'image/png', 'image/jpeg')`),
])

export const hotelDocument = pgTable('hotel_document', {
  documentId: uuid('document_id').notNull(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  hotelId: uuid('hotel_id').notNull(),
  docType: text('doc_type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.documentId] }),
  foreignKey({ columns: [t.organizationId, t.documentId], foreignColumns: [documentAsset.organizationId, documentAsset.id], name: 'hotel_document_asset_fk' }),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'hotel_document_hotel_fk' }),
  index('hotel_document_hotel_idx').on(t.organizationId, t.hotelId),
  // Covers the composite FK to document_asset (the PK alone leads with document_id, not the FK's column set).
  index('hotel_document_asset_idx').on(t.organizationId, t.documentId),
  check('hotel_document_type_check', sql`${t.docType} in ('LICENSE', 'CONTRACT', 'INSURANCE', 'PERMIT', 'OTHER')`),
])
