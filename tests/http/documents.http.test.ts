import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, inject, it } from 'vitest'
import { documentAsset, hotelDocument } from '../../db/schema'
import { trustedHotelScope } from '../../server/security/scope'
import { ROLE_DEFINITIONS } from '../../shared/constants/roles'
import { apiClient, type ApiResponse } from './support/client'
import { expectStandardError } from './support/errorShape'
import { assignRole, closeTestDb, getHttpTestDb, makeHotel, makeLoginableUser, makeOrg, makeRole, truncateAllTables } from './support/fixtures'

const baseUrl = inject('httpTestBaseUrl')
const storageDir = inject('httpTestStorageDir')
const client = apiClient(baseUrl)
const db = getHttpTestDb()
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))

afterEach(async () => {
  await truncateAllTables()
})

afterAll(async () => {
  await closeTestDb()
})

type OrgScope = Awaited<ReturnType<typeof makeOrg>>['scope']
type Org = Awaited<ReturnType<typeof makeOrg>>['organization']

async function loginInOrg(organization: Org, scope: OrgScope, permissions: readonly string[], opts: { allHotels?: boolean, hotelIds?: string[] } = {}) {
  const { user, password } = await makeLoginableUser(db, scope, { allHotels: opts.allHotels ?? false, hotelIds: opts.hotelIds })
  const role = await makeRole(db, scope, { permissions })
  await assignRole(db, scope, user.id, role.id)
  const login = await client.login(organization.slug, user.email, password)
  expect(login.status).toBe(200)
  return { cookie: login.cookie, user }
}

const MANAGER = ROLE_DEFINITIONS.HOTEL_MANAGER!.permissions
const RECEPTION = ROLE_DEFINITIONS.RECEPTION!.permissions

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('http licence body é')])
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])

interface UploadOptions {
  cookie?: string
  file?: { bytes: Uint8Array | null, type?: string, name?: string } | null
  fields?: Record<string, string | undefined>
  extraFiles?: Array<{ field: string, bytes: Uint8Array, name: string }>
  rawFields?: Array<[string, string]>
}

/** A real multipart/form-data request (fetch + FormData), returning status/json/headers. */
async function uploadRequest(hotelId: string, o: UploadOptions = {}): Promise<ApiResponse> {
  const form = new FormData()
  const fields = { docType: 'LICENSE', title: 'Operating licence', ...o.fields }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v)
  for (const [k, v] of o.rawFields ?? []) form.append(k, v)
  const file = o.file === undefined ? { bytes: PDF_BYTES, type: 'application/pdf', name: 'licence.pdf' } : o.file
  if (file && file.bytes) form.append('file', new Blob([file.bytes], { type: file.type ?? 'application/pdf' }), file.name ?? 'licence.pdf')
  for (const extra of o.extraFiles ?? []) form.append(extra.field, new Blob([extra.bytes], { type: 'application/pdf' }), extra.name)
  const res = await fetch(`${baseUrl}/api/hotels/${hotelId}/documents`, { method: 'POST', headers: o.cookie ? { cookie: o.cookie } : {}, body: form, redirect: 'manual' })
  const text = await res.text()
  let json: unknown = null
  if (text.length > 0) { try { json = JSON.parse(text) } catch { json = text } }
  return { status: res.status, json, setCookie: [] }
}

async function download(hotelId: string, documentId: string, cookie?: string, query = '') {
  const res = await fetch(`${baseUrl}/api/hotels/${hotelId}/documents/${documentId}/download${query}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
  const bytes = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, bytes, json: (() => { try { return JSON.parse(bytes.toString('utf8')) } catch { return null } })() }
}

/** An org with an active hotel, a manager, a receptionist, and a second hotel (+ a manager who only reaches it). */
async function setup() {
  const { organization, scope } = await makeOrg(db)
  const hotel = await makeHotel(db, scope)
  const hotel2 = await makeHotel(db, scope)
  const manager = await loginInOrg(organization, scope, MANAGER, { hotelIds: [hotel.id] })
  const reception = await loginInOrg(organization, scope, RECEPTION, { hotelIds: [hotel.id] })
  const manager2 = await loginInOrg(organization, scope, MANAGER, { hotelIds: [hotel2.id] })
  return { organization, scope, hotel, hotel2, hotelScope: trustedHotelScope(scope, hotel.id), manager, reception, manager2 }
}

async function uploadOk(hotelId: string, cookie: string, o: UploadOptions = {}) {
  const res = await uploadRequest(hotelId, { ...o, cookie })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json as { id: string, originalFilename: string, mimeType: string, sizeBytes: number, sha256: string, docType: string, title: string, description: string | null, archivedAt: string | null, uploadedBy: string | null, createdAt: string }
}

describe('documents — 401 without a session (every route)', () => {
  it('upload, list, download and archive -> 401 with the standard error shape', async () => {
    const hotelId = '11111111-1111-1111-1111-111111111111'
    const id = '22222222-2222-2222-2222-222222222222'
    expectStandardError(await uploadRequest(hotelId), { status: 401 })
    expectStandardError(await client.request(`/api/hotels/${hotelId}/documents`), { status: 401 })
    const dl = await download(hotelId, id)
    expect(dl.status).toBe(401)
    expectStandardError(await client.request(`/api/hotels/${hotelId}/documents/${id}/archive`, { method: 'POST' }), { status: 401 })
  })
})

describe('documents — upload over real multipart HTTP', () => {
  it('PDF, PNG and JPEG upload -> 201 DTO without a storage key; each lands under the storage root', async () => {
    const { hotel, manager } = await setup()
    const pdf = await uploadOk(hotel.id, manager.cookie, { fields: { docType: 'CONTRACT', title: 'Supplier contract', description: 'Signed 2026' } })
    const png = await uploadOk(hotel.id, manager.cookie, { file: { bytes: PNG_BYTES, type: 'image/png', name: 'stamp.png' } })
    const jpg = await uploadOk(hotel.id, manager.cookie, { file: { bytes: JPG_BYTES, type: 'image/jpeg', name: 'scan.jpg' } })

    expect(pdf).toMatchObject({ docType: 'CONTRACT', title: 'Supplier contract', description: 'Signed 2026', originalFilename: 'licence.pdf', mimeType: 'application/pdf', sizeBytes: PDF_BYTES.length, uploadedBy: manager.user.id, archivedAt: null })
    expect(png).toMatchObject({ mimeType: 'image/png', sizeBytes: PNG_BYTES.length })
    expect(jpg).toMatchObject({ mimeType: 'image/jpeg', sizeBytes: JPG_BYTES.length })
    expect(Object.keys(pdf)).not.toContain('storageKey')
    expect(JSON.stringify(pdf)).not.toContain('.pdf/')

    const assets = await db.select().from(documentAsset)
    expect(assets).toHaveLength(3)
    for (const a of assets) {
      expect(a.storageKey).toMatch(/^[0-9a-f-]{36}\/\d{4}\/[0-9a-f-]{36}\.(pdf|png|jpg)$/)
      expect(existsSync(join(storageDir, a.storageKey))).toBe(true)
    }
    expect(await readFile(join(storageDir, assets.find(a => a.id === pdf.id)!.storageKey))).toEqual(PDF_BYTES)
  })

  it('a filename of ../../etc/passwd displays as passwd, and the key/file location are unaffected', async () => {
    const { organization, hotel, manager } = await setup()
    const dto = await uploadOk(hotel.id, manager.cookie, { file: { bytes: PDF_BYTES, type: 'application/pdf', name: '../../etc/passwd' } })
    expect(dto.originalFilename).toBe('passwd')
    const [asset] = await db.select().from(documentAsset)
    expect(asset!.storageKey).toMatch(new RegExp(`^${organization.id}/\\d{4}/[0-9a-f-]{36}\\.pdf$`))
    expect(asset!.storageKey).not.toContain('passwd')
    expect(existsSync(join(storageDir, asset!.storageKey))).toBe(true)
    expect(existsSync(join(storageDir, '..', 'etc'))).toBe(false)
    expect(await readdir(join(storageDir, organization.id))).toHaveLength(1)
  })

  it('a renamed .exe declared as PDF -> 422 CONTENT_MISMATCH; SVG -> 422 TYPE_NOT_ALLOWED; empty -> 422 EMPTY_FILE; nothing stored', async () => {
    const { hotel, manager } = await setup()
    expectStandardError(await uploadRequest(hotel.id, { cookie: manager.cookie, file: { bytes: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0]), type: 'application/pdf', name: 'invoice.pdf' } }), { status: 422, code: 'CONTENT_MISMATCH' })
    expectStandardError(await uploadRequest(hotel.id, { cookie: manager.cookie, file: { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), type: 'image/svg+xml', name: 'logo.svg' } }), { status: 422, code: 'TYPE_NOT_ALLOWED' })
    expectStandardError(await uploadRequest(hotel.id, { cookie: manager.cookie, file: { bytes: Buffer.alloc(0), type: 'application/pdf', name: 'empty.pdf' } }), { status: 422, code: 'EMPTY_FILE' })
    expect(await db.select().from(documentAsset)).toEqual([])
  })

  it('exactly 10 MB is accepted; 10 MB + 1 byte -> 422 FILE_TOO_LARGE; a 12 MB body is refused from its Content-Length', async () => {
    const { hotel, manager } = await setup()
    const exactly = Buffer.alloc(10 * 1024 * 1024); PDF_BYTES.copy(exactly)
    const ok = await uploadRequest(hotel.id, { cookie: manager.cookie, file: { bytes: exactly, type: 'application/pdf', name: 'big.pdf' } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(201)
    expect((ok.json as { sizeBytes: number }).sizeBytes).toBe(10_485_760)

    const plusOne = Buffer.alloc(10 * 1024 * 1024 + 1); PDF_BYTES.copy(plusOne)
    expectStandardError(await uploadRequest(hotel.id, { cookie: manager.cookie, file: { bytes: plusOne, type: 'application/pdf', name: 'big.pdf' } }), { status: 422, code: 'FILE_TOO_LARGE' })

    const twelve = Buffer.alloc(12 * 1024 * 1024); PDF_BYTES.copy(twelve)
    expectStandardError(await uploadRequest(hotel.id, { cookie: manager.cookie, file: { bytes: twelve, type: 'application/pdf', name: 'huge.pdf' } }), { status: 422, code: 'FILE_TOO_LARGE' })
    expect(await db.select().from(documentAsset)).toHaveLength(1)
  }, 60_000)

  it('a body without Content-Length (chunked) is refused with 411 before it is read', async () => {
    const { hotel, manager } = await setup()
    const status = await new Promise<{ status: number, body: string }>((resolve, reject) => {
      const url = new URL(`${baseUrl}/api/hotels/${hotel.id}/documents`)
      const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { cookie: manager.cookie, 'content-type': 'multipart/form-data; boundary=xyz', 'transfer-encoding': 'chunked' } }, (res) => {
        let body = ''
        res.on('data', c => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, body }))
      })
      req.on('error', reject)
      req.write('--xyz\r\nContent-Disposition: form-data; name="title"\r\n\r\nx\r\n')
      req.end('--xyz--\r\n')
    })
    expect(status.status).toBe(411)
    expect(JSON.parse(status.body).data.code).toBe('LENGTH_REQUIRED')
    expect(await db.select().from(documentAsset)).toEqual([])
  })

  it('malformed metadata -> 422 VALIDATION_FAILED: bad/missing docType, blank/missing title, overlong title/description, unknown field, duplicate field', async () => {
    const { hotel, manager } = await setup()
    const cookie = manager.cookie
    const failed = async (o: UploadOptions) => expectStandardError(await uploadRequest(hotel.id, { cookie, ...o }), { status: 422, code: 'VALIDATION_FAILED' })
    await failed({ fields: { docType: 'INVOICE' } })
    await failed({ fields: { docType: '' } })
    await failed({ fields: { docType: undefined } })
    await failed({ fields: { title: '   ' } })
    await failed({ fields: { title: undefined } })
    await failed({ fields: { title: 'x'.repeat(201) } })
    await failed({ fields: { description: 'y'.repeat(2001) } })
    await failed({ fields: { storageKey: '../../x.pdf' } })
    await failed({ fields: { hotelId: hotel.id } })
    await failed({ rawFields: [['title', 'second title']] })
    await failed({ rawFields: [['__proto__', 'x']] })
    await failed({ rawFields: [['constructor', 'x']] })
    await failed({ extraFiles: [{ field: 'file', bytes: PDF_BYTES, name: 'second.pdf' }] })
    await failed({ extraFiles: [{ field: 'attachment', bytes: PDF_BYTES, name: 'other.pdf' }] })
    await failed({ file: null })
    expect(await db.select().from(documentAsset)).toEqual([])
  })

  it('a non-multipart body -> 422 VALIDATION_FAILED', async () => {
    const { hotel, manager } = await setup()
    const res = await client.request(`/api/hotels/${hotel.id}/documents`, { method: 'POST', cookie: manager.cookie, body: { docType: 'LICENSE', title: 'x' } })
    expectStandardError(res, { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('reception (hotel.view) -> 403 and nothing is read or stored; a manager of another hotel / a foreign hotel / a missing hotel -> identical 404', async () => {
    const { hotel, hotel2, manager, reception, manager2 } = await setup()
    expectStandardError(await uploadRequest(hotel.id, { cookie: reception.cookie }), { status: 403, code: 'FORBIDDEN' })
    expect(await db.select().from(documentAsset)).toEqual([])

    const other = await setup()
    const results = [
      await uploadRequest(hotel.id, { cookie: manager2.cookie }), // same org, no access
      await uploadRequest(other.hotel.id, { cookie: manager.cookie }), // foreign org
      await uploadRequest('99999999-9999-4999-8999-999999999999', { cookie: manager.cookie }), // missing
    ]
    for (const r of results) expectStandardError(r, { status: 404, code: 'HOTEL_NOT_FOUND' })
    expect(new Set(results.map(r => JSON.stringify({ m: r.json.statusMessage, d: r.json.data })))).toHaveLength(1)
    expect(hotel2.id).toBeTruthy()
    expect(await db.select().from(documentAsset)).toEqual([])
  })
})

describe('documents — list, download, archive', () => {
  it('list: active documents for viewers; archived hidden; includeArchived 403 for viewers and ok for managers', async () => {
    const { hotel, manager, reception } = await setup()
    const a = await uploadOk(hotel.id, manager.cookie, { fields: { title: 'A' } })
    const b = await uploadOk(hotel.id, manager.cookie, { fields: { title: 'B' } })
    await client.request(`/api/hotels/${hotel.id}/documents/${a.id}/archive`, { method: 'POST', cookie: manager.cookie })

    const viewer = await client.request(`/api/hotels/${hotel.id}/documents`, { cookie: reception.cookie })
    expect(viewer.status).toBe(200)
    expect(viewer.json).toMatchObject({ total: 1, page: 1, items: [{ id: b.id, title: 'B' }] })
    expect(JSON.stringify(viewer.json)).not.toContain('storageKey')

    expectStandardError(await client.request(`/api/hotels/${hotel.id}/documents?includeArchived=true`, { cookie: reception.cookie }), { status: 403, code: 'FORBIDDEN' })
    const all = await client.request(`/api/hotels/${hotel.id}/documents?includeArchived=true`, { cookie: manager.cookie })
    expect(all.json.items.map((i: { id: string }) => i.id).sort()).toEqual([a.id, b.id].sort())
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/documents?includeArchived=yes`, { cookie: manager.cookie }), { status: 422, code: 'VALIDATION_FAILED' })
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/documents?bogus=1`, { cookie: manager.cookie }), { status: 422, code: 'VALIDATION_FAILED' })
  })

  it('download returns the exact bytes with attachment, stored type, nosniff, no-store and length; reception can download', async () => {
    const { hotel, manager, reception } = await setup()
    const dto = await uploadOk(hotel.id, manager.cookie, { file: { bytes: PDF_BYTES, type: 'application/pdf', name: 'ترخيص الفندق.pdf' } })

    for (const cookie of [manager.cookie, reception.cookie]) {
      const res = await download(hotel.id, dto.id, cookie)
      expect(res.status).toBe(200)
      expect(res.bytes).toEqual(PDF_BYTES)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-length')).toBe(String(PDF_BYTES.length))
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      const disposition = res.headers.get('content-disposition')!
      expect(disposition.startsWith('attachment;')).toBe(true)
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('ترخيص الفندق.pdf')}`)
      expect(disposition).toMatch(/filename="[\x20-\x7E]+"/)
      expect(res.headers.get('location')).toBeNull()
    }
  })

  it('download of PNG and JPEG keeps the stored content type; a hostile stored name cannot break the header', async () => {
    const { hotel, manager } = await setup()
    const png = await uploadOk(hotel.id, manager.cookie, { file: { bytes: PNG_BYTES, type: 'IMAGE/PNG', name: 'a";filename="evil.exe' } })
    const res = await download(hotel.id, png.id, manager.cookie)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.bytes).toEqual(PNG_BYTES)
    const disposition = res.headers.get('content-disposition')!
    expect(disposition.split(';')).toHaveLength(3) // attachment; filename="…"; filename*=…
    expect(disposition).not.toMatch(/filename="[^"]*"[^;]*"/)
    const jpg = await uploadOk(hotel.id, manager.cookie, { file: { bytes: JPG_BYTES, type: 'image/jpeg', name: 'scan.jpg' } })
    expect((await download(hotel.id, jpg.id, manager.cookie)).headers.get('content-type')).toBe('image/jpeg')
  })

  it('archive: manager 200 with archivedAt; repeat -> 409 DOCUMENT_ALREADY_ARCHIVED; reception 403; the object stays on disk', async () => {
    const { hotel, manager, reception } = await setup()
    const dto = await uploadOk(hotel.id, manager.cookie)
    const [asset] = await db.select().from(documentAsset)

    expectStandardError(await client.request(`/api/hotels/${hotel.id}/documents/${dto.id}/archive`, { method: 'POST', cookie: reception.cookie }), { status: 403, code: 'FORBIDDEN' })
    const archived = await client.request(`/api/hotels/${hotel.id}/documents/${dto.id}/archive`, { method: 'POST', cookie: manager.cookie })
    expect(archived.status).toBe(200)
    expect(archived.json).toMatchObject({ id: dto.id })
    expect(typeof archived.json.archivedAt).toBe('string')
    expectStandardError(await client.request(`/api/hotels/${hotel.id}/documents/${dto.id}/archive`, { method: 'POST', cookie: manager.cookie }), { status: 409, code: 'DOCUMENT_ALREADY_ARCHIVED' })
    expect(existsSync(join(storageDir, asset!.storageKey))).toBe(true)
    expect(await db.select().from(hotelDocument)).toHaveLength(1)
  })

  it('an archived document is 404 for a viewer; managers need includeArchived=true; a viewer asking for it gets 403', async () => {
    const { hotel, manager, reception } = await setup()
    const dto = await uploadOk(hotel.id, manager.cookie)
    await client.request(`/api/hotels/${hotel.id}/documents/${dto.id}/archive`, { method: 'POST', cookie: manager.cookie })

    const viewer = await download(hotel.id, dto.id, reception.cookie)
    expect(viewer.status).toBe(404)
    expect(viewer.json.data.code).toBe('DOCUMENT_NOT_FOUND')
    expect((await download(hotel.id, dto.id, manager.cookie)).status).toBe(404)
    expect((await download(hotel.id, dto.id, reception.cookie, '?includeArchived=true')).status).toBe(403)
    const withFlag = await download(hotel.id, dto.id, manager.cookie, '?includeArchived=true')
    expect(withFlag.status).toBe(200)
    expect(withFlag.bytes).toEqual(PDF_BYTES)
  })

  it('foreign documents: another hotel\'s, another org\'s and a random id are the same 404 for download and archive; a foreign/inaccessible/missing hotel is HOTEL_NOT_FOUND', async () => {
    const a = await setup()
    const b = await setup()
    const inHotel2 = await uploadOk(a.hotel2.id, a.manager2.cookie)
    const inOtherOrg = await uploadOk(b.hotel.id, b.manager.cookie)
    const ownDoc = await uploadOk(a.hotel.id, a.manager.cookie)
    const none = '99999999-9999-4999-8999-999999999999'

    const downloads = [await download(a.hotel.id, inHotel2.id, a.manager.cookie), await download(a.hotel.id, inOtherOrg.id, a.manager.cookie), await download(a.hotel.id, none, a.manager.cookie)]
    for (const d of downloads) {
      expect(d.status).toBe(404)
      expect(d.json.data.code).toBe('DOCUMENT_NOT_FOUND')
    }
    expect(new Set(downloads.map(d => JSON.stringify({ m: d.json.statusMessage, d: d.json.data })))).toHaveLength(1)
    for (const id of [inHotel2.id, inOtherOrg.id, none]) {
      expectStandardError(await client.request(`/api/hotels/${a.hotel.id}/documents/${id}/archive`, { method: 'POST', cookie: a.manager.cookie }), { status: 404, code: 'DOCUMENT_NOT_FOUND' })
    }
    // a document id used under the wrong hotel path
    expect((await download(a.hotel2.id, ownDoc.id, a.manager2.cookie)).status).toBe(404)
    // hotels the caller cannot see
    for (const hotelId of [a.hotel2.id, b.hotel.id, none]) {
      expectStandardError(await client.request(`/api/hotels/${hotelId}/documents`, { cookie: a.manager.cookie }), { status: 404, code: 'HOTEL_NOT_FOUND' })
      expect((await download(hotelId, ownDoc.id, a.manager.cookie)).json.data.code).toBe('HOTEL_NOT_FOUND')
      expectStandardError(await client.request(`/api/hotels/${hotelId}/documents/${ownDoc.id}/archive`, { method: 'POST', cookie: a.manager.cookie }), { status: 404, code: 'HOTEL_NOT_FOUND' })
    }
    expect((await db.select().from(documentAsset)).filter(r => r.archivedAt)).toEqual([])
  })

  it('a document whose stored object vanished -> a clean 500 DOCUMENT_FILE_MISSING with no path in the body', async () => {
    const { hotel, manager } = await setup()
    const dto = await uploadOk(hotel.id, manager.cookie)
    const [asset] = await db.select().from(documentAsset)
    const { rm } = await import('node:fs/promises')
    await rm(join(storageDir, asset!.storageKey))
    const res = await download(hotel.id, dto.id, manager.cookie)
    expect(res.status).toBe(500)
    expect(res.json.data.code).toBe('DOCUMENT_FILE_MISSING')
    expect(res.bytes.toString('utf8')).not.toContain(asset!.storageKey)
    expect(res.bytes.toString('utf8')).not.toContain(storageDir)
  })
})

describe('documents — startup configuration', () => {
  it('a server started with an unsupported STORAGE_DRIVER fails to start (explicit error, no fallback to local)', async () => {
    const result = await new Promise<{ code: number | null, output: string }>((resolve, reject) => {
      const child = spawn('node', ['.output/server/index.mjs'], { cwd: PROJECT_ROOT, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', STORAGE_DRIVER: 's3' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let listening = false
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server did not exit; output so far:\n${output}`)) }, 20_000)
      const onData = (c: Buffer) => {
        output += c.toString('utf8')
        if (/Listening on/.test(output)) listening = true
        if (listening) { clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(`server started despite STORAGE_DRIVER=s3:\n${output}`)) }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }) })
    })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/STORAGE_DRIVER/)
  }, 30_000)
})
