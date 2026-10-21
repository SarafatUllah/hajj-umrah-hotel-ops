import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { ZodError } from 'zod'
import type { ListDocumentsQuery, UploadDocumentFields } from '../../shared/schemas/document'
import { uploadDocumentFieldsSchema } from '../../shared/schemas/document'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../errors/domainError'
import { hotelRepos, tenantRepos } from '../repositories'
import type { HotelDocumentView } from '../repositories/hotel'
import type { AuthContext } from '../security/authContext'
import { authorizeHotel, requireOrgPermission } from '../security/authorize'
import { generateStorageKey, getStorageDriver, StorageObjectNotFoundError, UploadRejectedError, validateUpload, type StorageDriver } from '../storage'
import { recordAudit } from './audit'
import { type DocumentDto, toDocumentDto } from './documentDto'

/**
 * Hotel documents (Task 19): metadata in Postgres, bytes behind the `StorageDriver`.
 *
 * Permissions: `hotel.view` reads (list/download, inactive hotels included, like every read), `hotel.manage`
 * writes (upload/archive). Writes REJECT an inactive hotel (409 HOTEL_INACTIVE) — documents are not one of the
 * hotel-edit exceptions (profile, settings, reactivation), so the inventory-write rule applies.
 *
 * Archived documents: hidden from the list and 404 for download by default. `includeArchived=true` is a
 * manager-only view: a caller without `hotel.manage` who asks for it gets 403 FORBIDDEN (never a silently
 * ignored flag), whether or not any archived document exists.
 */

export interface DocumentUploadInput {
  /** The text fields of the multipart form, raw: validated here again (direct callers bypass the HTTP schema). */
  fields: Record<string, unknown>
  file: { bytes: Uint8Array, mimeType: string, filename: string }
}

export interface DocumentPage { items: DocumentDto[], page: number, pageSize: number, total: number }

export interface DocumentDownload {
  stream: Readable
  mimeType: string
  filename: string
  sizeBytes: number
}

function parseFields(raw: Record<string, unknown>): UploadDocumentFields {
  try {
    return uploadDocumentFieldsSchema.parse(raw)
  }
  catch (error) {
    if (!(error instanceof ZodError)) throw error
    throw new ValidationError('VALIDATION_FAILED', 'Request validation failed', { issues: error.issues.map(i => ({ path: i.path, message: i.message })) })
  }
}

function notFound(): NotFoundError {
  return new NotFoundError('DOCUMENT_NOT_FOUND')
}

/**
 * Authorization only — lets the HTTP route refuse an unauthorized caller BEFORE it reads (and buffers)
 * a multi-megabyte request body.
 */
export async function assertCanUploadDocument(ctx: AuthContext, hotelId: string): Promise<void> {
  await authorizeHotel(ctx, 'hotel.manage', hotelId)
}

/**
 * Order: authorize -> validate fields and bytes -> generate the key -> write the object -> ONE
 * transaction (asset row, hotel_document row, DOCUMENT_ADDED audit). If that transaction fails for any
 * reason (a constraint, the audit write, a dropped connection) the object is deleted again, and a
 * failure of that cleanup is logged but never replaces the original error. If the object write itself
 * fails, nothing was recorded. (A commit whose acknowledgement is lost after it succeeded would make
 * the cleanup remove a referenced object; that window is the accepted cost of write-then-record.)
 */
export async function uploadHotelDocument(ctx: AuthContext, hotelId: string, input: DocumentUploadInput, storage: StorageDriver = getStorageDriver()): Promise<DocumentDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'hotel.manage', hotelId)
  const fields = parseFields(input.fields)

  let validated: ReturnType<typeof validateUpload>
  try {
    validated = validateUpload(input.file.bytes, input.file.mimeType, input.file.filename)
  }
  catch (error) {
    if (error instanceof UploadRejectedError) throw new ValidationError(error.code, error.message)
    throw error
  }

  const sha256 = createHash('sha256').update(input.file.bytes).digest('hex')
  const storageKey = generateStorageKey(ctx.scope.organizationId, validated.extension, ctx.now())

  await storage.put(storageKey, input.file.bytes)

  try {
    return await ctx.db.transaction(async (tx) => {
      const tenant = tenantRepos(tx, ctx.scope)
      const asset = await tenant.documentAssets.insert({
        storageKey,
        originalFilename: validated.safeFilename,
        mimeType: validated.mimeType,
        sizeBytes: input.file.bytes.byteLength,
        sha256,
        uploadedBy: ctx.identity.userId,
      })
      const hotelScoped = hotelRepos(tx, scope)
      await hotelScoped.hotelDocuments.insert({
        documentId: asset.id,
        docType: fields.docType,
        title: fields.title,
        description: fields.description,
      })
      const view = (await hotelScoped.hotelDocuments.findView(asset.id))!
      await recordAudit(tenant.audit, ctx.identity.userId, {
        hotelId: hotel.id,
        entityType: 'document',
        entityId: asset.id,
        action: 'DOCUMENT_ADDED',
        after: { docType: fields.docType, title: fields.title, originalFilename: asset.originalFilename, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256 },
      })
      return toDocumentDto(view)
    })
  }
  catch (error) {
    try {
      await storage.delete(storageKey)
    }
    catch (cleanupError) {
      // Never mask the original failure; the orphan's key is logged so an operator can remove it.
      console.error('Document upload: could not remove the stored object after a failed transaction', { storageKey, cleanupError })
    }
    throw error
  }
}

export async function listHotelDocuments(ctx: AuthContext, hotelId: string, query: ListDocumentsQuery): Promise<DocumentPage> {
  const { scope } = await authorizeHotel(ctx, 'hotel.view', hotelId, { allowInactive: true })
  if (query.includeArchived) requireOrgPermission(ctx, 'hotel.manage')

  const page = await hotelRepos(ctx.db, scope).hotelDocuments.list({ includeArchived: query.includeArchived, page: query.page, pageSize: query.pageSize })
  return { items: page.rows.map(toDocumentDto), page: query.page, pageSize: query.pageSize, total: page.total }
}

/**
 * Streams a document through the API (there is no public URL). The lookup is confined to this hotel;
 * a nonexistent id, another hotel's, another organization's — and, without `includeArchived`, an
 * archived one — are the same 404 DOCUMENT_NOT_FOUND.
 */
export async function downloadHotelDocument(ctx: AuthContext, hotelId: string, documentId: string, opts: { includeArchived: boolean }, storage: StorageDriver = getStorageDriver()): Promise<DocumentDownload> {
  const { scope } = await authorizeHotel(ctx, 'hotel.view', hotelId, { allowInactive: true })
  if (opts.includeArchived) requireOrgPermission(ctx, 'hotel.manage')

  const view = await hotelRepos(ctx.db, scope).hotelDocuments.findView(documentId)
  if (!view || (view.asset.archivedAt && !opts.includeArchived)) throw notFound()

  try {
    const stream = await storage.get(view.asset.storageKey)
    return { stream, mimeType: view.asset.mimeType, filename: view.asset.originalFilename, sizeBytes: view.asset.sizeBytes }
  }
  catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      // Metadata without bytes is an operator problem, not a client one: a clean 500 with no path or key.
      console.error('Document download: the stored object is missing', { documentId: view.document.documentId, hotelId })
      throw new DomainError('DOCUMENT_FILE_MISSING', 'The stored file for this document is unavailable', 500)
    }
    throw error
  }
}

/**
 * Sets `archived_at` (+ the DOCUMENT_ARCHIVED audit row, same transaction). The object and the rows
 * stay. Repeating it is a stable 409 DOCUMENT_ALREADY_ARCHIVED (the convention of every other state
 * change here: FLOOR_ALREADY_INACTIVE, ALREADY_INACTIVE, …), and it writes no second audit row.
 */
export async function archiveHotelDocument(ctx: AuthContext, hotelId: string, documentId: string): Promise<DocumentDto> {
  const { hotel, scope } = await authorizeHotel(ctx, 'hotel.manage', hotelId)

  return ctx.db.transaction(async (tx) => {
    const hotelScoped = hotelRepos(tx, scope)
    const tenant = tenantRepos(tx, ctx.scope)
    const current: HotelDocumentView | null = await hotelScoped.hotelDocuments.findView(documentId, { forUpdate: true })
    if (!current) throw notFound()
    if (current.asset.archivedAt) throw new ConflictError('DOCUMENT_ALREADY_ARCHIVED', 'This document is already archived')

    const archived = await tenant.documentAssets.markArchived(current.asset.id, ctx.now())
    if (!archived) throw new ConflictError('DOCUMENT_ALREADY_ARCHIVED', 'This document is already archived')

    await recordAudit(tenant.audit, ctx.identity.userId, {
      hotelId: hotel.id,
      entityType: 'document',
      entityId: current.document.documentId,
      action: 'DOCUMENT_ARCHIVED',
      before: { archivedAt: null },
      after: { archivedAt: archived.archivedAt },
    })
    return toDocumentDto({ document: current.document, asset: archived })
  })
}
