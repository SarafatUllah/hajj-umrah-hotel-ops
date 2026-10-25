/**
 * `Content-Disposition: attachment` for an arbitrary (already display-sanitized, but never trusted
 * here) filename: an ASCII-only quoted fallback plus the RFC 5987/6266 `filename*=UTF-8''…` form.
 * Quotes, backslashes, semicolons, percent signs, CR/LF and every other control or non-ASCII
 * character are removed from the fallback and percent-encoded in the extended form, so the filename
 * cannot terminate the parameter, add a parameter, or inject a header line.
 */
export function attachmentDisposition(filename: string): string {
  const wellFormed = filename.toWellFormed() // encodeURIComponent throws on a lone surrogate
  const fallback = wellFormed.replace(/[^\x20-\x7E]|["\\;%]/g, '_').trim() || 'document'
  // RFC 5987 attr-char: encodeURIComponent additionally leaves ! ' ( ) * ~ ; only ' ( ) * must go.
  const encoded = encodeURIComponent(wellFormed).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
