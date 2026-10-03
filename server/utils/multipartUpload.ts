import type { H3Event } from 'h3'
import { getRequestHeader, readMultipartFormData } from 'h3'
import { DomainError, ValidationError } from '../errors/domainError'
import { MAX_UPLOAD_BYTES } from '../storage/uploadValidation'

/** Headroom over the file limit for the multipart framing and the (small) text fields. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024

export interface ParsedUploadForm {
  fields: Record<string, string>
  file: { bytes: Uint8Array, mimeType: string, filename: string }
}

function formIssue(path: string, message: string): ValidationError {
  return new ValidationError('VALIDATION_FAILED', 'Request validation failed', { issues: [{ path: [path], message }] })
}

/**
 * Reads the upload form through h3's `readMultipartFormData` (no hand-parsing). That helper buffers
 * the WHOLE request body in memory before it returns, so the size bound has to be enforced BEFORE it
 * is called, from the declared length:
 *   - a missing/invalid `Content-Length`, or any `Transfer-Encoding` (chunked bodies have no declared
 *     length), is refused with 411 — there would be no bound at all;
 *   - a declared length above the file limit plus framing overhead is refused with 422 FILE_TOO_LARGE
 *     without reading a byte.
 * HTTP/1.1 framing makes the declared length binding (the server reads exactly that many bytes), so
 * at most MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES are ever buffered. The file's own size is then
 * validated again on the actual bytes (`validateUpload`). Known limitation: a body up to that bound
 * is held in memory (twice transiently while h3 splits it) — fine for a 10 MB cap, but this is not a
 * streaming upload.
 */
export async function readUploadForm(event: H3Event): Promise<ParsedUploadForm> {
  const contentType = getRequestHeader(event, 'content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw formIssue('file', 'Expected a multipart/form-data upload')

  const lengthHeader = getRequestHeader(event, 'content-length')
  if (getRequestHeader(event, 'transfer-encoding') !== undefined || lengthHeader === undefined || !/^\d+$/.test(lengthHeader.trim())) {
    throw new DomainError('LENGTH_REQUIRED', 'Uploads must declare their Content-Length', 411)
  }
  if (Number(lengthHeader) > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
    throw new ValidationError('FILE_TOO_LARGE', `Files are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  }

  const parts = await readMultipartFormData(event)
  if (!parts || parts.length === 0) throw formIssue('file', 'The upload form is empty or malformed')

  // No prototype: a part named `__proto__` must be an ordinary (and then rejected, as unknown) field, never silently swallowed.
  const fields = Object.create(null) as Record<string, string>
  let file: ParsedUploadForm['file'] | undefined
  for (const part of parts) {
    if (!part.name) throw formIssue('file', 'Every form part needs a name')
    if (part.name === 'file') {
      if (file) throw formIssue('file', 'Exactly one file is expected')
      file = { bytes: part.data, mimeType: part.type ?? '', filename: part.filename ?? '' }
      continue
    }
    // Only the `file` part may carry a file; anything else is an unexpected upload, not a text field.
    if (part.filename !== undefined) throw formIssue(part.name, 'Unexpected file field')
    if (Object.prototype.hasOwnProperty.call(fields, part.name)) throw formIssue(part.name, 'Field given more than once')
    fields[part.name] = part.data.toString('utf8')
  }
  if (!file) throw formIssue('file', 'A file is required')
  return { fields, file }
}
