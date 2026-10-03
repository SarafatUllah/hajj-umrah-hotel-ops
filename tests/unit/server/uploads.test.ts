import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { DomainError, ValidationError } from '../../../server/errors/domainError'
import { attachmentDisposition } from '../../../server/utils/contentDisposition'
import { MULTIPART_OVERHEAD_BYTES, readUploadForm } from '../../../server/utils/multipartUpload'
import { createStorageDriver, generateStorageKey, UnsupportedStorageDriverError } from '../../../server/storage'
import { InvalidStorageKeyError, isValidStorageKey, LocalStorageDriver, StorageObjectNotFoundError } from '../../../server/storage/localStorageDriver'
import { MAX_UPLOAD_BYTES, type UploadRejectedError, sanitizeFilename, validateUpload } from '../../../server/storage/uploadValidation'

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0])
const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]) // "MZ" — a Windows executable
const reason = (fn: () => unknown) => { try { fn() } catch (e) { return (e as UploadRejectedError).code } return 'OK' }

describe('validateUpload', () => {
  it('accepts real PDF, PNG and JPEG content with a matching declared type', () => {
    expect(validateUpload(pdf, 'application/pdf', 'licence.pdf')).toMatchObject({ mimeType: 'application/pdf', extension: '.pdf' })
    expect(validateUpload(png, 'image/png', 'a.png')).toMatchObject({ mimeType: 'image/png', extension: '.png' })
    expect(validateUpload(jpg, 'IMAGE/JPEG', 'a.jpeg')).toMatchObject({ mimeType: 'image/jpeg', extension: '.jpg' })
  })

  it('normalizes the declared type case-insensitively and ignores parameters', () => {
    expect(validateUpload(pdf, 'Application/PDF', 'a.pdf').mimeType).toBe('application/pdf')
    expect(validateUpload(pdf, ' application/pdf ; charset=binary', 'a.pdf').mimeType).toBe('application/pdf')
  })

  it('rejects a declared type that is not on the allow-list', () => {
    expect(reason(() => validateUpload(pdf, 'application/x-msdownload', 'a.exe'))).toBe('TYPE_NOT_ALLOWED')
    expect(reason(() => validateUpload(pdf, 'text/html', 'a.html'))).toBe('TYPE_NOT_ALLOWED')
    expect(reason(() => validateUpload(pdf, 'image/svg+xml', 'a.svg'))).toBe('TYPE_NOT_ALLOWED')
    expect(reason(() => validateUpload(pdf, 'image/gif', 'a.gif'))).toBe('TYPE_NOT_ALLOWED')
    expect(reason(() => validateUpload(pdf, '', 'a.pdf'))).toBe('TYPE_NOT_ALLOWED')
    for (const proto of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(reason(() => validateUpload(pdf, proto, 'a'))).toBe('TYPE_NOT_ALLOWED')
  })

  it('rejects SVG even when its bytes are an SVG document', () => {
    expect(reason(() => validateUpload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'a.svg'))).toBe('TYPE_NOT_ALLOWED')
  })

  it('rejects content that does not match the declared type (renamed file), whatever the file extension says', () => {
    expect(reason(() => validateUpload(new TextEncoder().encode('MZ...'), 'application/pdf', 'invoice.pdf'))).toBe('CONTENT_MISMATCH')
    expect(reason(() => validateUpload(exe, 'application/pdf', 'invoice.pdf'))).toBe('CONTENT_MISMATCH')
    expect(reason(() => validateUpload(png, 'application/pdf', 'x.pdf'))).toBe('CONTENT_MISMATCH')
    expect(reason(() => validateUpload(pdf, 'image/png', 'x.png'))).toBe('CONTENT_MISMATCH')
    expect(reason(() => validateUpload(pdf, 'image/jpeg', 'x.jpg'))).toBe('CONTENT_MISMATCH')
    // An allowed extension never rescues bad bytes, and a disallowed extension never blocks good ones.
    expect(reason(() => validateUpload(exe, 'image/png', 'x.png'))).toBe('CONTENT_MISMATCH')
    expect(reason(() => validateUpload(pdf, 'application/pdf', 'x.exe'))).toBe('OK')
  })

  it('rejects a file shorter than its signature', () => {
    expect(reason(() => validateUpload(new Uint8Array([0x25, 0x50]), 'application/pdf', 'a.pdf'))).toBe('CONTENT_MISMATCH')
    expect(reason(() => validateUpload(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'a.png'))).toBe('CONTENT_MISMATCH')
  })

  it('rejects empty and oversized files at the exact boundary', () => {
    expect(reason(() => validateUpload(new Uint8Array(), 'application/pdf', 'a.pdf'))).toBe('EMPTY_FILE')
    const exactly = new Uint8Array(MAX_UPLOAD_BYTES); exactly.set(pdf)
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
    expect(reason(() => validateUpload(exactly, 'application/pdf', 'a.pdf'))).toBe('OK')
    expect(reason(() => validateUpload(new Uint8Array(MAX_UPLOAD_BYTES + 1), 'application/pdf', 'a.pdf'))).toBe('FILE_TOO_LARGE')
    // Size is checked before type: a huge file of a bad type is "too large", an empty one is "empty".
    expect(reason(() => validateUpload(new Uint8Array(MAX_UPLOAD_BYTES + 1), 'text/html', 'a.html'))).toBe('FILE_TOO_LARGE')
    expect(reason(() => validateUpload(new Uint8Array(), 'text/html', 'a.html'))).toBe('EMPTY_FILE')
  })
})

describe('sanitizeFilename (display only)', () => {
  it('strips paths, control characters and leading dots; bounds length; falls back', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\x\\licence.pdf')).toBe('licence.pdf')
    expect(sanitizeFilename('a\u0000b\u001F.pdf')).toBe('ab.pdf')
    expect(sanitizeFilename('.hidden')).toBe('hidden')
    expect(sanitizeFilename('ترخيص الفندق.pdf')).toBe('ترخيص الفندق.pdf')
    expect(sanitizeFilename('x'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(120)
    expect(sanitizeFilename('   ')).toBe('document')
    expect(sanitizeFilename('')).toBe('document')
  })

  it('keeps the extension when it truncates', () => {
    const long = sanitizeFilename('x'.repeat(500) + '.pdf')
    expect(long.endsWith('.pdf')).toBe(true)
    expect(long).toHaveLength(120)
  })

  it('handles dots, separators and whitespace edge cases', () => {
    for (const name of ['...', '.', '..', '/', '\\', '//', '../', '.. ', ' . . ', '\t\n', '\u0000']) expect(sanitizeFilename(name), JSON.stringify(name)).toBe('document')
    expect(sanitizeFilename('dir/')).toBe('document')
    expect(sanitizeFilename('. .a')).toBe('a')
    expect(sanitizeFilename('  ..  spaced.pdf  ')).toBe('spaced.pdf')
    expect(sanitizeFilename('a/b\\c/d.pdf')).toBe('d.pdf')
    expect(sanitizeFilename('..\\..\\windows\\system32\\x.pdf')).toBe('x.pdf')
  })

  it('normalizes to NFC and removes line separators, C1 controls and bidi overrides', () => {
    expect(sanitizeFilename('e\u0301.pdf')).toBe('\u00e9.pdf')
    expect(sanitizeFilename('a\u2028b\u2029c\u0085d.pdf')).toBe('abcd.pdf')
    expect(sanitizeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe')
    expect(sanitizeFilename('a\r\nb.pdf')).toBe('ab.pdf')
  })

  it('does not cut a surrogate pair in half when truncating', () => {
    const name = '\u{1F600}'.repeat(100) // 200 UTF-16 units
    const out = sanitizeFilename(name)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out).toBe(out.toWellFormed())
  })

  it('never returns a name that could act as a path', () => {
    for (const name of ['../../etc/passwd', '..\\..\\x', '/abs/path', 'C:\\x\\y', 'a/../b', '%2e%2e%2fx']) {
      const out = sanitizeFilename(name)
      expect(out).not.toMatch(/[\\/]/)
      expect(out.startsWith('.')).toBe(false)
    }
  })
})

describe('isValidStorageKey / generateStorageKey', () => {
  it('accepts server-shaped keys and rejects everything else', () => {
    expect(isValidStorageKey('11111111-1111-1111-1111-111111111111/2026/abc-123.pdf')).toBe(true)
    expect(isValidStorageKey('a.pdf')).toBe(true)
    for (const bad of ['', '../evil.pdf', 'a/../../evil.pdf', '/etc/passwd.pdf', 'a//b.pdf', 'a/b.pdf/', 'a b.pdf', 'a\\b.pdf', 'noext', 'a/.pdf', '.pdf', 'a/./b.pdf', 'a/b.PDF', 'a/b.p', 'a/b.pdf\u0000', 'a/b.pdf\n', 'a/b.tar.gz', 'é/a.pdf', 'a/b.pdf ', ' a/b.pdf', 'a/..pdf', 'x'.repeat(600) + '.pdf']) {
      expect(isValidStorageKey(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(isValidStorageKey(undefined)).toBe(false)
    expect(isValidStorageKey(42)).toBe(false)
  })

  it('builds <organizationId>/<year>/<uuid><ext> from trusted parts only', () => {
    const org = '11111111-1111-4111-8111-111111111111'
    const key = generateStorageKey(org, '.pdf', new Date('2026-09-25T00:00:00Z'))
    expect(key).toMatch(/^11111111-1111-4111-8111-111111111111\/2026\/[0-9a-f-]{36}\.pdf$/)
    expect(isValidStorageKey(key)).toBe(true)
    expect(generateStorageKey(org, '.pdf')).not.toBe(generateStorageKey(org, '.pdf'))
    expect(() => generateStorageKey('../x', '.pdf')).toThrow()
    expect(() => generateStorageKey(org, '/../x')).toThrow()
    expect(() => generateStorageKey(org, 'pdf')).toThrow()
  })
})

describe('createStorageDriver', () => {
  it('builds the local driver', () => {
    expect(createStorageDriver({ driver: 'local', localDir: tmpdir() })).toBeInstanceOf(LocalStorageDriver)
  })

  it('throws for an unsupported driver — never a silent fallback to local', () => {
    for (const driver of ['s3', '', 'LOCAL', 'memory']) {
      expect(() => createStorageDriver({ driver, localDir: tmpdir() })).toThrow(UnsupportedStorageDriverError)
    }
  })
})

describe('LocalStorageDriver', () => {
  let dir: string
  let outside: string
  let driver: LocalStorageDriver
  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'hotel-uploads-'))
    dir = join(base, 'root')
    outside = join(base, 'outside')
    await mkdir(dir, { recursive: true })
    await mkdir(outside, { recursive: true })
    driver = new LocalStorageDriver(dir)
  })
  afterAll(async () => { await rm(join(dir, '..'), { recursive: true, force: true }) })

  it('stores, reads, checks existence and deletes by server-generated key', async () => {
    const key = '11111111-1111-1111-1111-111111111111/2026/abc-123.pdf'
    await driver.put(key, pdf)
    expect(await driver.exists(key)).toBe(true)
    const chunks: Buffer[] = []
    for await (const c of await driver.get(key)) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(pdf))
    await driver.delete(key)
    expect(await driver.exists(key)).toBe(false)
  })

  it('writes inside the root', async () => {
    await driver.put('org/2026/inside.pdf', pdf)
    expect(await readFile(join(dir, 'org/2026/inside.pdf'))).toEqual(Buffer.from(pdf))
  })

  it('never overwrites an existing object', async () => {
    const key = 'org/2026/once.pdf'
    await driver.put(key, pdf)
    await expect(driver.put(key, png)).rejects.toThrow()
    expect(await readFile(join(dir, key))).toEqual(Buffer.from(pdf))
  })

  it('refuses traversal, absolute paths, double slashes and odd characters', async () => {
    for (const bad of ['../evil.pdf', 'a/../../evil.pdf', '/etc/passwd.pdf', 'a//b.pdf', 'a/b.pdf/', 'a b.pdf', 'a\\b.pdf', 'noext', '', 'a/b\u0000.pdf', 'a/.pdf']) {
      await expect(driver.put(bad, pdf)).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(driver.exists(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(driver.get(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(driver.delete(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError)
    }
    expect(existsSync(join(dir, '..', 'evil.pdf'))).toBe(false)
  })

  it('reports a missing object cleanly: get -> StorageObjectNotFoundError, delete is idempotent', async () => {
    await expect(driver.get('org/2026/missing.pdf')).rejects.toBeInstanceOf(StorageObjectNotFoundError)
    expect(await driver.exists('org/2026/missing.pdf')).toBe(false)
    await expect(driver.delete('org/2026/missing.pdf')).resolves.toBeUndefined()
    const fresh = new LocalStorageDriver(join(dir, 'does-not-exist-yet'))
    expect(await fresh.exists('a/b.pdf')).toBe(false)
    await expect(fresh.get('a/b.pdf')).rejects.toBeInstanceOf(StorageObjectNotFoundError)
  })

  it('does not follow a symlink that leads out of the root', async () => {
    await writeFile(join(outside, 'secret.pdf'), pdf)
    await mkdir(join(dir, 'link-org'), { recursive: true })
    await symlink(outside, join(dir, 'link-org', '2026'))
    // a directory symlink: neither write nor read may cross it
    await expect(driver.put('link-org/2026/planted.pdf', pdf)).rejects.toBeInstanceOf(InvalidStorageKeyError)
    expect(existsSync(join(outside, 'planted.pdf'))).toBe(false)
    await expect(driver.get('link-org/2026/secret.pdf')).rejects.toBeInstanceOf(InvalidStorageKeyError)
    await expect(driver.exists('link-org/2026/secret.pdf')).rejects.toBeInstanceOf(InvalidStorageKeyError)
    await expect(driver.delete('link-org/2026/secret.pdf')).rejects.toBeInstanceOf(InvalidStorageKeyError)
    expect(existsSync(join(outside, 'secret.pdf'))).toBe(true)
    // a file symlink: same
    await mkdir(join(dir, 'file-link'), { recursive: true })
    await symlink(join(outside, 'secret.pdf'), join(dir, 'file-link', 'x.pdf'))
    await expect(driver.get('file-link/x.pdf')).rejects.toBeInstanceOf(InvalidStorageKeyError)
    await expect(driver.put('file-link/x.pdf', pdf)).rejects.toThrow() // O_EXCL: the symlink is "something there"
    expect(await readFile(join(outside, 'secret.pdf'))).toEqual(Buffer.from(pdf))
  })

  it('leaves no partial file when the write fails', async () => {
    await expect(driver.put('partial/2026/bad.pdf', { byteLength: 1 } as unknown as Uint8Array)).rejects.toThrow()
    expect(existsSync(join(dir, 'partial/2026/bad.pdf'))).toBe(false)
    expect(await readdir(join(dir, 'partial/2026'))).toEqual([])
  })
})

describe('attachmentDisposition', () => {
  const parts = (header: string) => {
    const m = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9%._~!$&+-]*)$/.exec(header)
    expect(m, header).not.toBeNull()
    return { fallback: m![1]!, extended: decodeURIComponent(m![2]!) }
  }

  it('encodes a plain name both ways', () => {
    expect(attachmentDisposition('licence.pdf')).toBe('attachment; filename="licence.pdf"; filename*=UTF-8\'\'licence.pdf')
  })

  it('round-trips Unicode through filename* and keeps an ASCII fallback', () => {
    const { fallback, extended } = parts(attachmentDisposition('ترخيص الفندق.pdf'))
    expect(extended).toBe('ترخيص الفندق.pdf')
    expect(fallback).toMatch(/^[\x20-\x7E]+$/)
    expect(fallback.endsWith('.pdf')).toBe(true)
    expect(parts(attachmentDisposition('é\u{1F600}.png')).extended).toBe('é\u{1F600}.png')
  })

  it('cannot be broken out of by quotes, semicolons, backslashes, CR/LF or percent signs', () => {
    for (const hostile of ['a".pdf', 'a";filename="evil.exe', 'a\\".pdf', 'x;y=z.pdf', 'a\r\nSet-Cookie: x=1.pdf', 'a\nb.pdf', '100%.pdf', "it's (1)*.pdf", 'a\u0000b.pdf']) {
      const header = attachmentDisposition(hostile)
      expect(header, JSON.stringify(hostile)).not.toMatch(/[\r\n\0]/)
      const { fallback, extended } = parts(header)
      expect(fallback).not.toMatch(/["\\;%\r\n]/)
      expect(extended).toBe(hostile)
      // exactly two parameters: filename and filename*
      expect(header.split(';')).toHaveLength(3)
    }
  })

  it('survives a lone surrogate and an empty name', () => {
    expect(() => attachmentDisposition('a\uD800b.pdf')).not.toThrow()
    expect(attachmentDisposition('')).toContain('filename="document"')
  })
})

describe('readUploadForm: the size bound is enforced from the declared length BEFORE any body is read', () => {
  // A bare event with headers only: if the function tried to read the body it would throw a TypeError
  // (no request stream), which is not any of the expected errors below.
  const eventWith = (headers: Record<string, string>) => ({ node: { req: { headers, method: 'POST' } } }) as unknown as H3Event
  const multipart = 'multipart/form-data; boundary=xyz'

  it('rejects a declared length above the file limit plus framing overhead with 422 FILE_TOO_LARGE', async () => {
    const error = await readUploadForm(eventWith({ 'content-type': multipart, 'content-length': String(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES + 1) })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).code).toBe('FILE_TOO_LARGE')
  })

  it('refuses a missing, malformed or negative Content-Length, and any Transfer-Encoding, with 411', async () => {
    for (const headers of [{}, { 'content-length': 'abc' }, { 'content-length': '-5' }, { 'content-length': '1e9' }, { 'content-length': '10', 'transfer-encoding': 'chunked' }, { 'transfer-encoding': 'chunked' }]) {
      const error = await readUploadForm(eventWith({ 'content-type': multipart, ...headers })).catch((e: unknown) => e)
      expect(error, JSON.stringify(headers)).toBeInstanceOf(DomainError)
      expect((error as DomainError).code).toBe('LENGTH_REQUIRED')
      expect((error as DomainError).httpStatus).toBe(411)
    }
  })

  it('rejects a body that is not multipart/form-data', async () => {
    for (const type of ['application/json', 'text/plain', '', 'multipart/mixed; boundary=x']) {
      const error = await readUploadForm(eventWith({ 'content-type': type, 'content-length': '10' })).catch((e: unknown) => e)
      expect((error as ValidationError).code, type).toBe('VALIDATION_FAILED')
    }
  })
})
