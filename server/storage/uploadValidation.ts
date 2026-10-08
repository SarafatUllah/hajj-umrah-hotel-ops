export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
/** Longest display filename kept (UTF-16 code units). */
export const MAX_FILENAME_LENGTH = 120

/** Allow-list: declared MIME type -> file signature the bytes must start with, and the extension we store. */
const ALLOWED = {
  'application/pdf': { signature: [0x25, 0x50, 0x44, 0x46, 0x2d], ext: '.pdf' },
  'image/png': { signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ext: '.png' },
  'image/jpeg': { signature: [0xff, 0xd8, 0xff], ext: '.jpg' },
} as const

export type AllowedMime = keyof typeof ALLOWED
export const ALLOWED_MIME_TYPES = Object.keys(ALLOWED) as AllowedMime[]

export type UploadRejection = 'EMPTY_FILE' | 'FILE_TOO_LARGE' | 'TYPE_NOT_ALLOWED' | 'CONTENT_MISMATCH'

export class UploadRejectedError extends Error {
  constructor(readonly code: UploadRejection, message: string) {
    super(message)
    this.name = 'UploadRejectedError'
  }
}

export interface ValidatedUpload { mimeType: AllowedMime, extension: string, safeFilename: string }

// C0/C1 controls, line/paragraph separators, BOM, and the bidirectional override/embedding/isolate
// characters (they can make a filename display as something else). Arabic letters are untouched.
// eslint-disable-next-line no-control-regex -- stripping control characters is the point.
const UNSAFE_CHARS =new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]', 'g')
const LEADING_DOTS_AND_SPACE = /^[.\s]+/

/**
 * Display-only filename: no paths (either separator), no control/bidi characters, no leading dots,
 * bounded length, never empty. It is NEVER used to build a storage path (keys are server-generated).
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.normalize('NFC').replace(UNSAFE_CHARS, '').replace(LEADING_DOTS_AND_SPACE, '').trim()
  let limited = cleaned
  if (limited.length > MAX_FILENAME_LENGTH) {
    limited = limited.slice(-MAX_FILENAME_LENGTH) // keep the tail: that is where the extension is
    // Do not start on the orphaned half of a surrogate pair; re-strip whatever the cut exposed.
    if (/^[\uDC00-\uDFFF]/.test(limited)) limited = limited.slice(1)
    limited = limited.replace(LEADING_DOTS_AND_SPACE, '').trim()
  }
  return limited.length > 0 ? limited : 'document'
}

/** Case-insensitive, parameters (`; charset=…`) dropped: only the bare type is ever stored. */
function normalizeMime(declared: string): string {
  return (declared.split(';')[0] ?? '').trim().toLowerCase()
}

/** The declared type must be on the allow-list AND the bytes must carry that type's signature (a renamed .exe is not a PDF). The filename's extension is never trusted. */
export function validateUpload(bytes: Uint8Array, declaredMime: string, filename: string): ValidatedUpload {
  if (bytes.byteLength === 0) throw new UploadRejectedError('EMPTY_FILE', 'The file is empty')
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new UploadRejectedError('FILE_TOO_LARGE', `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  const mimeType = normalizeMime(declaredMime)
  // Own-property lookup: `constructor`/`__proto__` etc. must not resolve to something on the prototype chain.
  const entry = Object.prototype.hasOwnProperty.call(ALLOWED, mimeType) ? ALLOWED[mimeType as AllowedMime] : undefined
  if (!entry) throw new UploadRejectedError('TYPE_NOT_ALLOWED', 'Only PDF, PNG and JPEG files are accepted')
  if (bytes.byteLength < entry.signature.length || !entry.signature.every((b, i) => bytes[i] === b)) {
    throw new UploadRejectedError('CONTENT_MISMATCH', 'The file content does not match its declared type')
  }
  return { mimeType: mimeType as AllowedMime, extension: entry.ext, safeFilename: sanitizeFilename(filename) }
}
