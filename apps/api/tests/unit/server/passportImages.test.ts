import { describe, expect, it } from 'vitest'
import { visionAnswerFields } from '../../../server/integrations/passportReaders'
import { imageSize } from '../../../server/storage'

// A real 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** A PNG whose header declares `width × height` (no pixel data needed to read it). */
function pngDeclaring(width: number, height: number): Buffer {
  const header = Buffer.from(PNG.subarray(0, 33))
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

/** SOI, an APP0 segment, padding fill bytes, then a baseline SOF0 frame of `width × height`. */
function jpegDeclaring(width: number, height: number): Buffer {
  const app0 = [0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00]
  const sof0 = [0xFF, 0xFF, 0xC0, 0x00, 0x0B, 0x08, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 0x01, 0x01, 0x11, 0x00]
  return Buffer.from([0xFF, 0xD8, ...app0, ...sof0])
}

describe('imageSize (decompression-bomb guard)', () => {
  it('reads the declared size of a PNG and of a JPEG without decoding them', () => {
    expect(imageSize(PNG, 'image/png')).toEqual({ width: 1, height: 1 })
    expect(imageSize(pngDeclaring(100_000, 100_000), 'image/png')).toEqual({ width: 100_000, height: 100_000 })
    expect(imageSize(jpegDeclaring(4032, 3024), 'image/jpeg')).toEqual({ width: 4032, height: 3024 })
  })

  it('a header it cannot read, or a zero size, is null (the upload is refused)', () => {
    expect(imageSize(PNG.subarray(0, 20), 'image/png')).toBeNull()
    expect(imageSize(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...Buffer.alloc(30)]), 'image/png')).toBeNull()
    expect(imageSize(pngDeclaring(0, 10), 'image/png')).toBeNull()
    expect(imageSize(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), 'image/jpeg')).toBeNull()
    expect(imageSize(Buffer.from([0xFF, 0xD8, 0x00, 0x00, 0x00, 0x00]), 'image/jpeg')).toBeNull()
  })
})

describe('visionAnswerFields (the AI answer is untrusted)', () => {
  const answer = { fullName: 'MD KARIM', gender: 'MALE', nationality: 'bgd', dateOfBirth: '1980-01-01', passportNo: 'a 123-4567', passportExpiry: '2032-01-01', placeOfBirth: 'DHAKA', passportIssueDate: '', issuingAuthority: '', address: '' }

  it('keeps well-formed fields, normalized; empty answers are not fields', () => {
    expect(visionAnswerFields(answer)).toEqual({ fullName: 'MD KARIM', gender: 'MALE', nationality: 'BGD', dateOfBirth: '1980-01-01', passportNo: 'A1234567', passportExpiry: '2032-01-01', placeOfBirth: 'DHAKA' })
  })

  it('drops dates that are not real calendar dates, names outside Latin letters, and anything of the wrong type', () => {
    const fields = visionAnswerFields({ ...answer, dateOfBirth: '1980-13-45', passportExpiry: '2032-02-30', fullName: '<b>Ignore the rules</b>', gender: 'X', nationality: 42 })
    expect(fields).toEqual({ passportNo: 'A1234567', placeOfBirth: 'DHAKA' })
  })
})
