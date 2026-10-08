import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../../db/schema'
import { auditLog, documentAsset, hotel as hotelTable, hotelDocument } from '../../../db/schema'
import type { Database } from '../../../db/client'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '../../../server/errors/domainError'
import { HotelDocumentRepository } from '../../../server/repositories/hotel'
import { AuditRepository } from '../../../server/repositories/tenant'
import type { AuthContext } from '../../../server/security/authContext'
import { trustedHotelScope, type OrganizationScope } from '../../../server/security/scope'
import { LocalStorageDriver, type StorageDriver } from '../../../server/storage'
import { MAX_UPLOAD_BYTES } from '../../../server/storage/uploadValidation'
import { listHotelAudit } from '../../../server/services/hotelService'
import { AUDIT_ENTITY_TYPES, listHotelAuditQuerySchema } from '../../../shared/schemas/hotel'
import { archiveHotelDocument, assertCanUploadDocument, downloadHotelDocument, listHotelDocuments, uploadHotelDocument } from '../../../server/services/documentService'
import type { Permission } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'
import { makeHotel, makeHotelDocument, makeOrg, makeUser } from '../../support/fixtures'
import { closeTestDb, getTestClient, getTestDb, truncateAllTables } from '../support/testDb'

const db = getTestDb()

afterEach(async () => {
  vi.restoreAllMocks()
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions as Permission[]
const RECEPTION = ROLE_DEFINITIONS.RECEPTION!.permissions as Permission[]

function makeCtx(scope: OrganizationScope, opts: { userId?: string, permissions?: readonly Permission[], allHotels?: boolean, hotelIds?: string[], now?: () => Date } = {}): AuthContext {
  return {
    identity: { userId: opts.userId ?? '00000000-0000-0000-0000-0000000000aa', organizationId: scope.organizationId, email: 'caller@test.com', fullName: 'Caller' },
    authz: { permissions: new Set(opts.permissions ?? []), allHotels: opts.allHotels ?? false, hotelIds: new Set(opts.hotelIds ?? []) },
    scope,
    db: db as Database,
    now: opts.now ?? (() => new Date('2026-09-25T10:00:00Z')),
  }
}

const pdf = (extra = 'body') => new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), ...new TextEncoder().encode(extra)])
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const fields = (overrides: Record<string, unknown> = {}) => ({ docType: 'LICENSE', title: 'Operating licence', ...overrides })
const pdfFile = (bytes = pdf(), filename = 'licence.pdf') => ({ bytes, mimeType: 'application/pdf', filename })

/** Records every key put/deleted, and delegates to a real LocalStorageDriver in a fresh temp directory. */
class RecordingStorage implements StorageDriver {
  readonly puts: string[] = []
  readonly deletes: string[] = []
  constructor(readonly inner: StorageDriver) {}
  async put(key: string, bytes: Uint8Array) { this.puts.push(key); await this.inner.put(key, bytes) }
  get(key: string) { return this.inner.get(key) }
  exists(key: string) { return this.inner.exists(key) }
  async delete(key: string) { this.deletes.push(key); await this.inner.delete(key) }
}

let dir: string
let storage: RecordingStorage

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'document-service-'))
  storage = new RecordingStorage(new LocalStorageDriver(dir))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function filesUnder(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) if (entry.isFile()) out.push(join(entry.parentPath, entry.name))
  return out
}

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return undefined
  }
  catch (error) {
    return error
  }
}

const assetRows = () => db.select().from(documentAsset)
const documentRows = () => db.select().from(hotelDocument)
const auditRows = (hotelId: string, action: string) => db.select().from(auditLog).where(and(eq(auditLog.hotelId, hotelId), eq(auditLog.action, action)))

/** Org + hotel + a real manager user + a real receptionist, each with access to the hotel. */
async function setup() {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope)
  const managerUser = await makeUser(db, scope)
  const receptionUser = await makeUser(db, scope)
  const manager = makeCtx(scope, { userId: managerUser.id, permissions: MANAGER, hotelIds: [hotel.id] })
  const reception = makeCtx(scope, { userId: receptionUser.id, permissions: RECEPTION, hotelIds: [hotel.id] })
  return { organization, scope, hotel, managerUser, receptionUser, manager, reception, hotelScope: trustedHotelScope(scope, hotel.id) }
}

async function upload(ctx: AuthContext, hotelId: string, over: { fields?: Record<string, unknown>, file?: ReturnType<typeof pdfFile> } = {}) {
  return uploadHotelDocument(ctx, hotelId, { fields: over.fields ?? fields(), file: over.file ?? pdfFile() }, storage)
}

describe('upload: the successful flow', () => {
  it('writes the object, the asset + hotel_document rows and the DOCUMENT_ADDED audit row', async () => {
    const { organization, hotel, manager, managerUser } = await setup()
    const bytes = pdf('licence-body')

    const dto = await upload(manager, hotel.id, { file: pdfFile(bytes, 'licence.pdf'), fields: fields({ description: 'Valid until 2030' }) })

    expect(dto).toMatchObject({ docType: 'LICENSE', title: 'Operating licence', description: 'Valid until 2030', originalFilename: 'licence.pdf', mimeType: 'application/pdf', sizeBytes: bytes.byteLength, sha256: sha256(bytes), uploadedBy: managerUser.id, archivedAt: null })
    expect(Object.keys(dto).sort()).toEqual(['archivedAt', 'createdAt', 'description', 'docType', 'id', 'mimeType', 'originalFilename', 'sha256', 'sizeBytes', 'title', 'uploadedBy'])
    expect(JSON.stringify(dto)).not.toContain(organization.id) // no storage key (it embeds the organization id)

    const [asset] = await assetRows()
    const [doc] = await documentRows()
    expect(asset).toMatchObject({ id: dto.id, organizationId: organization.id, sha256: sha256(bytes), sizeBytes: bytes.byteLength, mimeType: 'application/pdf', uploadedBy: managerUser.id, archivedAt: null })
    expect(doc).toMatchObject({ documentId: dto.id, organizationId: organization.id, hotelId: hotel.id, docType: 'LICENSE' })

    // server-generated key: <orgId>/<year>/<uuid>.pdf — and the object really is there, byte for byte
    expect(asset!.storageKey).toMatch(new RegExp(`^${organization.id}/2026/[0-9a-f-]{36}\\.pdf$`))
    expect(storage.puts).toEqual([asset!.storageKey])
    expect(await storage.exists(asset!.storageKey)).toBe(true)
    expect(await readAll(await storage.get(asset!.storageKey))).toEqual(Buffer.from(bytes))

    const [audit] = await auditRows(hotel.id, 'DOCUMENT_ADDED')
    expect(audit).toMatchObject({ entityType: 'document', entityId: dto.id, actorUserId: managerUser.id, organizationId: organization.id })
    expect(audit!.afterData).toMatchObject({ docType: 'LICENSE', title: 'Operating licence', sha256: sha256(bytes), sizeBytes: bytes.byteLength })
    expect(JSON.stringify(audit)).not.toContain(asset!.storageKey)
  })

  it('stores PNG and JPEG with their own extensions and the declared (normalized) MIME', async () => {
    const { hotel, manager } = await setup()
    const a = await upload(manager, hotel.id, { file: { bytes: png, mimeType: 'IMAGE/PNG', filename: 'stamp.png' } })
    const b = await upload(manager, hotel.id, { file: { bytes: jpg, mimeType: 'image/jpeg', filename: 'scan.jpeg' } })
    expect([a.mimeType, b.mimeType]).toEqual(['image/png', 'image/jpeg'])
    const keys = (await assetRows()).map(r => r.storageKey).sort()
    expect(keys.map(k => k.slice(k.lastIndexOf('.'))).sort()).toEqual(['.jpg', '.png'])
  })

  it('a hostile filename becomes a display name only: the key is generated and the file lands under the root', async () => {
    const { organization, hotel, manager } = await setup()
    const dto = await upload(manager, hotel.id, { file: pdfFile(pdf(), '../../etc/passwd') })
    expect(dto.originalFilename).toBe('passwd')
    const [asset] = await assetRows()
    expect(asset!.storageKey).toMatch(new RegExp(`^${organization.id}/2026/[0-9a-f-]{36}\\.pdf$`))
    expect(asset!.storageKey).not.toContain('passwd')
    const files = await filesUnder(dir)
    expect(files).toEqual([join(dir, asset!.storageKey)])
    expect(existsSync(join(dir, '..', 'etc'))).toBe(false)
  })

  it('accepts exactly 10 MB', async () => {
    const { hotel, manager } = await setup()
    const bytes = new Uint8Array(MAX_UPLOAD_BYTES)
    bytes.set(pdf())
    const dto = await upload(manager, hotel.id, { file: pdfFile(bytes) })
    expect(dto.sizeBytes).toBe(10_485_760)
    expect((await filesUnder(dir))).toHaveLength(1)
  })

  it('identical bytes uploaded twice are two documents with two distinct keys and the same sha256', async () => {
    const { hotel, manager } = await setup()
    const bytes = pdf('same')
    const a = await upload(manager, hotel.id, { file: pdfFile(bytes) })
    const b = await upload(manager, hotel.id, { file: pdfFile(bytes) })
    expect(a.id).not.toBe(b.id)
    expect(a.sha256).toBe(b.sha256)
    const rows = await assetRows()
    expect(new Set(rows.map(r => r.storageKey)).size).toBe(2)
    expect(await filesUnder(dir)).toHaveLength(2)
  })

  it('the stored key uses the injected clock\'s year', async () => {
    const { organization, scope, hotel, managerUser } = await setup()
    const ctx = makeCtx(scope, { userId: managerUser.id, permissions: MANAGER, hotelIds: [hotel.id], now: () => new Date('2031-01-02T00:00:00Z') })
    await upload(ctx, hotel.id)
    expect((await assetRows())[0]!.storageKey.startsWith(`${organization.id}/2031/`)).toBe(true)
  })
})

describe('upload: validation happens before anything is written', () => {
  async function expectRejected(hotelId: string, ctx: AuthContext, over: Parameters<typeof upload>[2], code: string) {
    const error = await catchError(() => upload(ctx, hotelId, over))
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).code).toBe(code)
    expect((error as ValidationError).httpStatus).toBe(422)
    expect(storage.puts).toEqual([])
    expect(await filesUnder(dir)).toEqual([])
    expect(await assetRows()).toEqual([])
    expect(await documentRows()).toEqual([])
    expect(await auditRows(hotelId, 'DOCUMENT_ADDED')).toEqual([])
  }

  it('EMPTY_FILE, FILE_TOO_LARGE (10 MB + 1), TYPE_NOT_ALLOWED (exe, svg), CONTENT_MISMATCH (renamed exe, PNG as PDF)', async () => {
    const { hotel, manager } = await setup()
    await expectRejected(hotel.id, manager, { file: pdfFile(new Uint8Array()) }, 'EMPTY_FILE')
    await expectRejected(hotel.id, manager, { file: pdfFile(new Uint8Array(MAX_UPLOAD_BYTES + 1)) }, 'FILE_TOO_LARGE')
    await expectRejected(hotel.id, manager, { file: { bytes: pdf(), mimeType: 'application/x-msdownload', filename: 'a.exe' } }, 'TYPE_NOT_ALLOWED')
    await expectRejected(hotel.id, manager, { file: { bytes: new TextEncoder().encode('<svg/>'), mimeType: 'image/svg+xml', filename: 'a.svg' } }, 'TYPE_NOT_ALLOWED')
    await expectRejected(hotel.id, manager, { file: { bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), mimeType: 'application/pdf', filename: 'invoice.pdf' } }, 'CONTENT_MISMATCH')
    await expectRejected(hotel.id, manager, { file: { bytes: png, mimeType: 'application/pdf', filename: 'x.pdf' } }, 'CONTENT_MISMATCH')
  })

  it('rejects bad metadata with VALIDATION_FAILED: docType, blank title, unknown field, overlong title/description', async () => {
    const { hotel, manager } = await setup()
    await expectRejected(hotel.id, manager, { fields: fields({ docType: 'INVOICE' }) }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: { title: 'x' } }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: fields({ title: '   ' }) }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: { docType: 'LICENSE' } }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: fields({ hotelId: '11111111-1111-1111-1111-111111111111' }) }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: fields({ storageKey: 'x/y.pdf' }) }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: fields({ title: 'x'.repeat(201) }) }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: fields({ description: 'x'.repeat(2001) }) }, 'VALIDATION_FAILED')
    await expectRejected(hotel.id, manager, { fields: fields({ title: 'a\u0000b' }) }, 'VALIDATION_FAILED')
  })

  it('accepts the bounds: title 200, description 2000 (with newlines); a blank description is stored as none', async () => {
    const { hotel, manager } = await setup()
    const a = await upload(manager, hotel.id, { fields: fields({ title: 'x'.repeat(200), description: `${'y'.repeat(1990)}\nline2` }) })
    expect(a.title).toHaveLength(200)
    expect(a.description).toContain('\n')
    const b = await upload(manager, hotel.id, { fields: fields({ description: '   ' }) })
    expect(b.description).toBeNull()
    const c = await upload(manager, hotel.id, { fields: { docType: 'PERMIT', title: '  Trimmed  ' } })
    expect(c).toMatchObject({ title: 'Trimmed', description: null, docType: 'PERMIT' })
  })
})

describe('upload: transaction and compensation', () => {
  it('an audit failure after the object write rolls the rows back AND deletes the object', async () => {
    const { hotel, manager } = await setup()
    const boom = new Error('audit boom')
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValueOnce(boom)

    const error = await catchError(() => upload(manager, hotel.id))

    expect(error).toBe(boom)
    expect(storage.puts).toHaveLength(1) // the object WAS written first …
    expect(storage.deletes).toEqual(storage.puts) // … and the same key was removed again
    expect(await storage.exists(storage.puts[0]!)).toBe(false)
    expect(await filesUnder(dir)).toEqual([])
    expect(await assetRows()).toEqual([])
    expect(await documentRows()).toEqual([])
  })

  it('a hotel_document failure rolls the asset row back too, and the object is deleted', async () => {
    const { hotel, manager } = await setup()
    const boom = new Error('hotel_document boom')
    vi.spyOn(HotelDocumentRepository.prototype, 'insert').mockRejectedValueOnce(boom)

    expect(await catchError(() => upload(manager, hotel.id))).toBe(boom)
    expect(await assetRows()).toEqual([])
    expect(await filesUnder(dir)).toEqual([])
  })

  it('a failed cleanup never masks the original error (and is logged without the file bytes)', async () => {
    const { hotel, manager } = await setup()
    const original = new Error('audit boom')
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValueOnce(original)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failingDelete: StorageDriver = { put: (k, b) => storage.put(k, b), get: k => storage.get(k), exists: k => storage.exists(k), delete: () => Promise.reject(new Error('disk gone')) }

    const error = await catchError(() => uploadHotelDocument(manager, hotel.id, { fields: fields(), file: pdfFile() }, failingDelete))

    expect(error).toBe(original)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(String(logged.mock.calls[0]![0])).toContain('could not remove the stored object')
    expect(await assetRows()).toEqual([])
  })

  it('a storage write failure records no metadata and no audit', async () => {
    const { hotel, manager } = await setup()
    const failingPut: StorageDriver = { put: () => Promise.reject(new Error('disk full')), get: k => storage.get(k), exists: k => storage.exists(k), delete: k => storage.delete(k) }

    const error = await catchError(() => uploadHotelDocument(manager, hotel.id, { fields: fields(), file: pdfFile() }, failingPut))

    expect((error as Error).message).toBe('disk full')
    expect(await assetRows()).toEqual([])
    expect(await documentRows()).toEqual([])
    expect(await auditRows(hotel.id, 'DOCUMENT_ADDED')).toEqual([])
    expect(storage.deletes).toEqual([]) // nothing to compensate: the put never succeeded
  })
})

describe('archive', () => {
  it('sets archived_at and writes DOCUMENT_ARCHIVED in the same transaction; the row and the bytes stay', async () => {
    const { hotel, manager, managerUser } = await setup()
    const dto = await upload(manager, hotel.id)
    const key = (await assetRows())[0]!.storageKey

    const archived = await archiveHotelDocument(manager, hotel.id, dto.id)

    expect(archived.id).toBe(dto.id)
    expect(archived.archivedAt).toBe('2026-09-25T10:00:00.000Z')
    const [asset] = await assetRows()
    expect(asset!.archivedAt).toEqual(new Date('2026-09-25T10:00:00Z'))
    expect(await documentRows()).toHaveLength(1)
    expect(await storage.exists(key)).toBe(true)
    expect(storage.deletes).toEqual([])
    const [audit] = await auditRows(hotel.id, 'DOCUMENT_ARCHIVED')
    expect(audit).toMatchObject({ entityType: 'document', entityId: dto.id, actorUserId: managerUser.id })
    expect(audit!.beforeData).toEqual({ archivedAt: null })
  })

  it('is hidden from the default list afterwards', async () => {
    const { hotel, manager } = await setup()
    const keep = await upload(manager, hotel.id, { fields: fields({ title: 'keep' }) })
    const drop = await upload(manager, hotel.id, { fields: fields({ title: 'drop' }) })
    await archiveHotelDocument(manager, hotel.id, drop.id)
    const list = await listHotelDocuments(manager, hotel.id, { includeArchived: false, page: 1, pageSize: 20 })
    expect(list.items.map(i => i.id)).toEqual([keep.id])
    expect(list.total).toBe(1)
  })

  it('archiving twice is a stable 409 DOCUMENT_ALREADY_ARCHIVED: no second audit row, archived_at unchanged', async () => {
    const { scope, hotel, manager, managerUser } = await setup()
    const dto = await upload(manager, hotel.id)
    await archiveHotelDocument(manager, hotel.id, dto.id)
    const later = makeCtx(scope, { userId: managerUser.id, permissions: MANAGER, hotelIds: [hotel.id], now: () => new Date('2027-01-01T00:00:00Z') })

    const error = await catchError(() => archiveHotelDocument(later, hotel.id, dto.id))

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).code).toBe('DOCUMENT_ALREADY_ARCHIVED')
    expect(await auditRows(hotel.id, 'DOCUMENT_ARCHIVED')).toHaveLength(1)
    expect((await assetRows())[0]!.archivedAt).toEqual(new Date('2026-09-25T10:00:00Z'))
  })

  it('an audit failure rolls the archive back', async () => {
    const { hotel, manager } = await setup()
    const dto = await upload(manager, hotel.id)
    const boom = new Error('audit boom')
    vi.spyOn(AuditRepository.prototype, 'record').mockRejectedValueOnce(boom)
    expect(await catchError(() => archiveHotelDocument(manager, hotel.id, dto.id))).toBe(boom)
    expect((await assetRows())[0]!.archivedAt).toBeNull()
  })

  it('concurrent archives: exactly one wins, the other gets the conflict, one audit row', async () => {
    const { hotel, manager } = await setup()
    const dto = await upload(manager, hotel.id)
    const results = await Promise.allSettled([archiveHotelDocument(manager, hotel.id, dto.id), archiveHotelDocument(manager, hotel.id, dto.id)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as ConflictError).code).toBe('DOCUMENT_ALREADY_ARCHIVED')
    expect(await auditRows(hotel.id, 'DOCUMENT_ARCHIVED')).toHaveLength(1)
  })
})

describe('document audit is filterable through the public audit contract (Phase 1 gate fix)', () => {
  const AUDIT = [...MANAGER, 'audit.view' as Permission]

  it('entityType=document returns DOCUMENT_ADDED and DOCUMENT_ARCHIVED for the document id; the internal table name hotel_document is not a public value; unfiltered still lists the rows', async () => {
    const { scope, hotel, managerUser } = await setup()
    const auditor = makeCtx(scope, { userId: managerUser.id, permissions: AUDIT, hotelIds: [hotel.id] })
    const dto = await upload(auditor, hotel.id)

    const added = await listHotelAudit(auditor, hotel.id, listHotelAuditQuerySchema.parse({ entityType: 'document', entityId: dto.id }))
    expect(added.items.map(i => [i.action, i.entityType, i.entityId])).toEqual([['DOCUMENT_ADDED', 'document', dto.id]])
    expect(added.items[0]!.actor).toMatchObject({ id: managerUser.id })

    await archiveHotelDocument(auditor, hotel.id, dto.id)
    const both = await listHotelAudit(auditor, hotel.id, listHotelAuditQuerySchema.parse({ entityType: 'document', entityId: dto.id }))
    expect(both.items.map(i => i.action).sort()).toEqual(['DOCUMENT_ADDED', 'DOCUMENT_ARCHIVED'])
    expect(both.items.every(i => i.entityType === 'document')).toBe(true)

    // The internal table name is not part of the public contract: the query schema keeps rejecting it.
    expect(listHotelAuditQuerySchema.safeParse({ entityType: 'hotel_document' }).success).toBe(false)
    expect(AUDIT_ENTITY_TYPES).toContain('document')
    expect(AUDIT_ENTITY_TYPES).not.toContain('hotel_document')

    // Unfiltered listing still exposes the document rows.
    const all = await listHotelAudit(auditor, hotel.id, listHotelAuditQuerySchema.parse({}))
    expect(all.items.filter(i => i.entityId === dto.id).map(i => i.action).sort()).toEqual(['DOCUMENT_ADDED', 'DOCUMENT_ARCHIVED'])
  })

  it('stays hotel- and organization-scoped: another hotel\'s audit list never shows the document, and another organization gets the plain 404', async () => {
    const { scope, hotel, managerUser } = await setup()
    const auditor = makeCtx(scope, { userId: managerUser.id, permissions: AUDIT, allHotels: true })
    const dto = await upload(auditor, hotel.id)
    const otherHotel = await makeHotel(db, scope)

    const elsewhere = await listHotelAudit(auditor, otherHotel.id, listHotelAuditQuerySchema.parse({ entityType: 'document' }))
    expect(elsewhere.items).toEqual([])

    const { scope: foreignScope } = await makeOrg(db)
    const foreignUser = await makeUser(db, foreignScope)
    const foreign = makeCtx(foreignScope, { userId: foreignUser.id, permissions: AUDIT, allHotels: true })
    const error = await catchError(() => listHotelAudit(foreign, hotel.id, listHotelAuditQuerySchema.parse({ entityType: 'document', entityId: dto.id })))
    expect(error).toBeInstanceOf(NotFoundError)
  })
})

describe('list and includeArchived', () => {
  it('lists newest first with pagination; reception (hotel.view) can list', async () => {
    const { hotel, manager, reception, hotelScope } = await setup()
    const first = await makeHotelDocument(db, hotelScope, { title: 'first' })
    await new Promise(r => setTimeout(r, 5))
    const second = await makeHotelDocument(db, hotelScope, { title: 'second' })
    const page = await listHotelDocuments(reception, hotel.id, { includeArchived: false, page: 1, pageSize: 1 })
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 1 })
    expect(page.items.map(i => i.id)).toEqual([second.document.documentId])
    const page2 = await listHotelDocuments(manager, hotel.id, { includeArchived: false, page: 2, pageSize: 1 })
    expect(page2.items.map(i => i.id)).toEqual([first.document.documentId])
  })

  it('includeArchived is manager-only: a hotel.view-only caller gets 403 FORBIDDEN (no archived record, even with none archived); a manager sees them', async () => {
    const { hotel, manager, reception } = await setup()
    const dto = await upload(manager, hotel.id)
    const q = { includeArchived: true, page: 1, pageSize: 20 }
    expect(await catchError(() => listHotelDocuments(reception, hotel.id, q))).toBeInstanceOf(ForbiddenError)
    await archiveHotelDocument(manager, hotel.id, dto.id)
    expect(await catchError(() => listHotelDocuments(reception, hotel.id, q))).toBeInstanceOf(ForbiddenError)
    const withArchived = await listHotelDocuments(manager, hotel.id, q)
    expect(withArchived.items.map(i => [i.id, i.archivedAt !== null])).toEqual([[dto.id, true]])
    expect((await listHotelDocuments(reception, hotel.id, { includeArchived: false, page: 1, pageSize: 20 })).items).toEqual([])
  })
})

describe('download', () => {
  it('streams the stored bytes with the stored metadata; reception can download an active document', async () => {
    const { hotel, manager, reception } = await setup()
    const bytes = pdf('download-me')
    const dto = await upload(manager, hotel.id, { file: pdfFile(bytes, 'ترخيص.pdf') })

    const file = await downloadHotelDocument(reception, hotel.id, dto.id, { includeArchived: false }, storage)

    expect(file).toMatchObject({ mimeType: 'application/pdf', filename: 'ترخيص.pdf', sizeBytes: bytes.byteLength })
    expect(await readAll(file.stream)).toEqual(Buffer.from(bytes))
  })

  it('an archived document is 404 for viewers AND for managers without includeArchived; a manager with includeArchived gets it; a viewer asking for includeArchived is 403', async () => {
    const { hotel, manager, reception } = await setup()
    const bytes = pdf('archived')
    const dto = await upload(manager, hotel.id, { file: pdfFile(bytes) })
    await archiveHotelDocument(manager, hotel.id, dto.id)

    for (const ctx of [reception, manager]) {
      const error = await catchError(() => downloadHotelDocument(ctx, hotel.id, dto.id, { includeArchived: false }, storage))
      expect(error).toBeInstanceOf(NotFoundError)
      expect((error as NotFoundError).code).toBe('DOCUMENT_NOT_FOUND')
    }
    expect(await catchError(() => downloadHotelDocument(reception, hotel.id, dto.id, { includeArchived: true }, storage))).toBeInstanceOf(ForbiddenError)
    const file = await downloadHotelDocument(manager, hotel.id, dto.id, { includeArchived: true }, storage)
    expect(await readAll(file.stream)).toEqual(Buffer.from(bytes))
  })

  it('a missing stored object gives a clean DOCUMENT_FILE_MISSING, never a path', async () => {
    const { hotel, manager } = await setup()
    const dto = await upload(manager, hotel.id)
    const key = (await assetRows())[0]!.storageKey
    await storage.inner.delete(key)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const error = await catchError(() => downloadHotelDocument(manager, hotel.id, dto.id, { includeArchived: false }, storage))

    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('DOCUMENT_FILE_MISSING')
    expect((error as DomainError).httpStatus).toBe(500)
    expect(JSON.stringify([(error as DomainError).message, (error as DomainError).details])).not.toContain(key)
    expect(JSON.stringify(logged.mock.calls)).not.toContain(key)
  })
})

describe('authorization and isolation', () => {
  it('missing permission: reception can neither upload nor archive (403); manager without hotel access gets 404', async () => {
    const { scope, hotel, manager, reception } = await setup()
    const dto = await upload(manager, hotel.id)
    expect(await catchError(() => upload(reception, hotel.id))).toBeInstanceOf(ForbiddenError)
    expect(await catchError(() => assertCanUploadDocument(reception, hotel.id))).toBeInstanceOf(ForbiddenError)
    expect(await catchError(() => archiveHotelDocument(reception, hotel.id, dto.id))).toBeInstanceOf(ForbiddenError)
    expect(await filesUnder(dir)).toHaveLength(1) // only the manager's upload

    const noAccess = makeCtx(scope, { permissions: MANAGER, hotelIds: [] })
    for (const call of [
      () => upload(noAccess, hotel.id),
      () => assertCanUploadDocument(noAccess, hotel.id),
      () => listHotelDocuments(noAccess, hotel.id, { includeArchived: false, page: 1, pageSize: 20 }),
      () => downloadHotelDocument(noAccess, hotel.id, dto.id, { includeArchived: false }, storage),
      () => archiveHotelDocument(noAccess, hotel.id, dto.id),
    ]) {
      const error = await catchError(call)
      expect(error).toBeInstanceOf(NotFoundError)
      expect((error as NotFoundError).code).toBe('HOTEL_NOT_FOUND')
    }
  })

  it('a same-org inaccessible hotel, a foreign-org hotel and a nonexistent hotel give the identical 404 HOTEL_NOT_FOUND', async () => {
    const a = await setup()
    const b = await setup()
    const otherHotelInOrgA = await makeHotel(db, a.scope)
    const dto = await upload(b.manager, b.hotel.id)
    const missing = '99999999-9999-4999-8999-999999999999'
    const errors: unknown[] = []
    for (const hotelId of [otherHotelInOrgA.id, b.hotel.id, missing]) {
      errors.push(await catchError(() => upload(a.manager, hotelId)))
      errors.push(await catchError(() => listHotelDocuments(a.manager, hotelId, { includeArchived: false, page: 1, pageSize: 20 })))
      errors.push(await catchError(() => downloadHotelDocument(a.manager, hotelId, dto.id, { includeArchived: false }, storage)))
      errors.push(await catchError(() => archiveHotelDocument(a.manager, hotelId, dto.id)))
    }
    // the manager only has access to a.hotel: all twelve are the same error
    for (const e of errors) {
      expect(e).toBeInstanceOf(NotFoundError)
      expect({ code: (e as NotFoundError).code, message: (e as NotFoundError).message, status: (e as NotFoundError).httpStatus }).toEqual({ code: 'HOTEL_NOT_FOUND', message: 'HOTEL_NOT_FOUND', status: 404 })
    }
    expect((await assetRows()).filter(r => r.archivedAt)).toEqual([])
  })

  it('a document of another hotel (same org), another org, or no document at all is the same 404 DOCUMENT_NOT_FOUND for download and archive', async () => {
    const a = await setup()
    const b = await setup()
    const hotelA2 = await makeHotel(db, a.scope)
    const ctxBoth = makeCtx(a.scope, { userId: a.managerUser.id, permissions: MANAGER, allHotels: true })
    const inA2 = await upload(ctxBoth, hotelA2.id)
    const inB = await upload(b.manager, b.hotel.id)
    const ownDoc = await upload(a.manager, a.hotel.id)
    const none = '99999999-9999-4999-8999-999999999999'

    const errors: NotFoundError[] = []
    for (const id of [inA2.id, inB.id, none]) {
      errors.push(await catchError(() => downloadHotelDocument(a.manager, a.hotel.id, id, { includeArchived: false }, storage)) as NotFoundError)
      errors.push(await catchError(() => archiveHotelDocument(a.manager, a.hotel.id, id)) as NotFoundError)
    }
    for (const e of errors) {
      expect(e).toBeInstanceOf(NotFoundError)
      expect({ code: e.code, message: e.message, status: e.httpStatus }).toEqual({ code: 'DOCUMENT_NOT_FOUND', message: 'DOCUMENT_NOT_FOUND', status: 404 })
    }
    // …and nothing was archived anywhere
    expect((await assetRows()).filter(r => r.archivedAt)).toEqual([])
    // the list of hotel A shows only its own
    const list = await listHotelDocuments(a.manager, a.hotel.id, { includeArchived: true, page: 1, pageSize: 50 })
    expect(list.items.map(i => i.id)).toEqual([ownDoc.id])
    // an all-hotels caller reaching hotel A2 through ITS path still cannot use A's document id there
    const viaWrongHotel = await catchError(() => downloadHotelDocument(ctxBoth, hotelA2.id, ownDoc.id, { includeArchived: false }, storage))
    expect(viaWrongHotel).toBeInstanceOf(NotFoundError)
    expect(await catchError(() => archiveHotelDocument(ctxBoth, hotelA2.id, ownDoc.id))).toBeInstanceOf(NotFoundError)
  })

  it('inactive hotel: reads (list, download) work; writes (upload, archive) are 409 HOTEL_INACTIVE and write nothing', async () => {
    const { scope, hotel, manager } = await setup()
    const dto = await upload(manager, hotel.id)
    await db.update(hotelTable).set({ status: 'INACTIVE' }).where(and(eq(hotelTable.id, hotel.id), eq(hotelTable.organizationId, scope.organizationId)))
    const putsBefore = storage.puts.length

    expect((await listHotelDocuments(manager, hotel.id, { includeArchived: false, page: 1, pageSize: 20 })).items).toHaveLength(1)
    expect(await readAll((await downloadHotelDocument(manager, hotel.id, dto.id, { includeArchived: false }, storage)).stream)).toHaveLength(dto.sizeBytes)
    for (const call of [() => upload(manager, hotel.id), () => archiveHotelDocument(manager, hotel.id, dto.id)]) {
      const error = await catchError(call)
      expect(error).toBeInstanceOf(ConflictError)
      expect((error as ConflictError).code).toBe('HOTEL_INACTIVE')
    }
    expect(storage.puts).toHaveLength(putsBefore)
    expect(await assetRows()).toHaveLength(1)
    expect((await assetRows())[0]!.archivedAt).toBeNull()
  })

  it('permission is checked before the file is looked at: reception uploading an invalid file is 403, not 422', async () => {
    const { hotel, reception } = await setup()
    expect(await catchError(() => upload(reception, hotel.id, { file: pdfFile(new Uint8Array()) }))).toBeInstanceOf(ForbiddenError)
  })
})

describe('repository scoping (captured SQL)', () => {
  it('findView and list carry each table\'s own organization predicate and the hotel predicate, bound to the scope; list is two statements', async () => {
    const { scope, hotel, hotelScope } = await setup()
    await makeHotelDocument(db, hotelScope)
    const logged: Array<{ query: string, params: unknown[] }> = []
    const loggingDb = drizzle(getTestClient(), { schema, logger: { logQuery: (query, params) => logged.push({ query, params }) } }) as Database
    const repo = new HotelDocumentRepository(loggingDb, hotelScope)

    const page = await repo.list({ includeArchived: false, page: 1, pageSize: 10 })
    const view = await repo.findView(page.rows[0]!.document.documentId)
    expect(view).not.toBeNull()

    expect(logged).toHaveLength(3) // list page + list total + findView — never one statement per document
    for (const { query, params } of logged) {
      for (const table of ['hotel_document', 'document_asset']) {
        const org = new RegExp(`"${table}"\\."organization_id" = \\$(\\d+)`).exec(query)
        expect(org, `${table}: ${query}`).not.toBeNull()
        expect(params[Number(org![1]) - 1]).toBe(scope.organizationId)
      }
      const hotelPredicate = /"hotel_document"\."hotel_id" = \$(\d+)/.exec(query)
      expect(hotelPredicate, query).not.toBeNull()
      expect(params[Number(hotelPredicate![1]) - 1]).toBe(hotel.id)
    }
  })
})
