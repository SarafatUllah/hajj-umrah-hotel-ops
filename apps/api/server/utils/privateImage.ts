import { type H3Event, send, setResponseHeaders } from 'h3'

/**
 * Sends a decrypted personal image (a passport photo) through the API: never cached, never sniffed into another
 * type, rendered sandboxed — like the hotel document downloads, but inline for the review card.
 */
export function sendPrivateImage(event: H3Event, image: { bytes: Buffer, mimeType: string }): Promise<void> {
  setResponseHeaders(event, {
    'Content-Type': image.mimeType,
    'Content-Length': String(image.bytes.length),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': 'default-src \'none\'; sandbox',
    'Content-Disposition': 'inline; filename="passport"',
    'Cross-Origin-Resource-Policy': 'same-site',
  })
  return send(event, image.bytes, image.mimeType)
}
