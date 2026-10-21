/** Width × height of a PNG or JPEG, read from its header; null when the bytes do not hold a readable header. */
export interface ImageSize { width: number, height: number }

const PNG_IHDR = 'IHDR'
/** A start-of-frame segment holds at least precision, height, width and the component count. */
const SOF_MIN_LENGTH = 8
// JPEG start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not.
const isStartOfFrame = (marker: number) => marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)
// Markers without a length field: TEM, RST0–7, SOI, EOI.
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)

function pngSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== PNG_IHDR) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function jpegSize(bytes: Buffer): ImageSize | null {
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xFF) return null
    const marker = bytes[offset + 1]!
    if (marker === 0xFF) { offset += 1; continue } // fill byte
    if (isStandalone(marker)) { offset += 2; continue }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return null
    if (isStartOfFrame(marker)) {
      if (length < SOF_MIN_LENGTH || offset + 9 > bytes.length) return null
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  return null
}

/**
 * The size an image declares, without decoding it: a small file can declare gigapixels (a decompression bomb), so
 * uploads that are decoded later (passport OCR) are checked against a pixel limit before they are accepted.
 */
export function imageSize(bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg'): ImageSize | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = mimeType === 'image/png' ? pngSize(buffer) : jpegSize(buffer)
  return size && size.width > 0 && size.height > 0 ? size : null
}
