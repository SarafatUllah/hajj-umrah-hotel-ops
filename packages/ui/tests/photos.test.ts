import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@hajj/contracts/constants/documents'
import { fitWithin, PHOTO_MAX_EDGE_PX, shrinkPhoto, type DecodedPhoto, type PhotoCodec, type PhotoSize } from '../app/utils/photos'

const LIMIT = 1000

/** A photo of `size` bytes and type. */
const fileOf = (bytes: number, type: string, name = 'passport.png') => new File([new Uint8Array(bytes)], name, { type, lastModified: 1_700_000_000_000 })

interface FakeCodecLog { decoded: number, encoded: Array<{ size: PhotoSize, quality: number }>, closed: number }

/**
 * A codec whose JPEGs weigh `bytesAt(quality, size)`: what a browser would produce, without a canvas.
 * `decode: null` = the browser cannot read the photo; `encodeFails` = drawing it throws.
 */
function fakeCodec(options: { size?: PhotoSize, bytesAt?: (quality: number, size: PhotoSize) => number, decode?: null, encodeFails?: boolean } = {}): { codec: PhotoCodec, log: FakeCodecLog } {
  const log: FakeCodecLog = { decoded: 0, encoded: [], closed: 0 }
  const size = options.size ?? { width: 4000, height: 3000 }
  const bytesAt = options.bytesAt ?? (() => LIMIT / 2)
  const codec: PhotoCodec = {
    async decode(): Promise<DecodedPhoto | null> {
      log.decoded += 1
      if (options.decode === null) return null
      return {
        size,
        async toJpeg(target, quality) {
          log.encoded.push({ size: target, quality })
          if (options.encodeFails) throw new Error('canvas lost')
          return new Blob([new Uint8Array(bytesAt(quality, target))], { type: 'image/jpeg' })
        },
        close() { log.closed += 1 },
      }
    },
  }
  return { codec, log }
}

describe('fitWithin', () => {
  it('scales the longest side down to the edge, keeping the shape', () => {
    expect(fitWithin({ width: 6000, height: 4000 }, 3000)).toEqual({ width: 3000, height: 2000 })
    expect(fitWithin({ width: 3024, height: 4032 }, 3000)).toEqual({ width: 2250, height: 3000 })
  })

  it('never enlarges a photo that already fits, and never rounds a side to nothing', () => {
    expect(fitWithin({ width: 1200, height: 800 }, 3000)).toEqual({ width: 1200, height: 800 })
    expect(fitWithin({ width: 9000, height: 1 }, 3000)).toEqual({ width: 3000, height: 1 })
  })
})

describe('shrinkPhoto', () => {
  it('sends a file within the upload limit untouched, without reading it', async () => {
    const { codec, log } = fakeCodec()
    const file = fileOf(LIMIT, 'image/jpeg')
    expect(await shrinkPhoto(file, codec, LIMIT)).toBe(file)
    expect(log.decoded).toBe(0)
  })

  it('leaves anything but a PNG or JPEG photo alone, however large (a PDF cannot be shrunk here)', async () => {
    const { codec, log } = fakeCodec()
    const file = fileOf(LIMIT * 5, 'application/pdf', 'contract.pdf')
    expect(await shrinkPhoto(file, codec, LIMIT)).toBe(file)
    expect(log.decoded).toBe(0)
  })

  it('redraws an oversized photo as a JPEG no larger than the longest edge allows, named .jpg', async () => {
    const { codec, log } = fakeCodec({ size: { width: 6000, height: 4000 } })
    const shrunk = await shrinkPhoto(fileOf(LIMIT * 3, 'image/png', 'Page 1.PNG'), codec, LIMIT)
    expect(shrunk).toMatchObject({ name: 'Page 1.jpg', type: 'image/jpeg', size: LIMIT / 2 })
    expect(log.encoded[0]!.size).toEqual(fitWithin({ width: 6000, height: 4000 }, PHOTO_MAX_EDGE_PX))
    expect(log.closed).toBe(1)
  })

  it('lowers the JPEG quality step by step and keeps the first version that fits', async () => {
    const { codec, log } = fakeCodec({ bytesAt: quality => (quality > 0.75 ? LIMIT + 1 : LIMIT) })
    const shrunk = await shrinkPhoto(fileOf(LIMIT * 3, 'image/jpeg', 'scan.jpeg'), codec, LIMIT)
    expect(log.encoded.map(step => step.quality)).toEqual([0.9, 0.8, 0.7])
    expect(shrunk).toMatchObject({ name: 'scan.jpg', size: LIMIT })
  })

  it('falls back to the original when no version fits, the photo cannot be read, or drawing it fails (the size check then explains)', async () => {
    const original = fileOf(LIMIT * 3, 'image/jpeg')
    const tooBig = fakeCodec({ bytesAt: () => LIMIT + 1 })
    expect(await shrinkPhoto(original, tooBig.codec, LIMIT)).toBe(original)
    expect(tooBig.log.closed).toBe(1)

    expect(await shrinkPhoto(original, fakeCodec({ decode: null }).codec, LIMIT)).toBe(original)

    const broken = fakeCodec({ encodeFails: true })
    expect(await shrinkPhoto(original, broken.codec, LIMIT)).toBe(original)
    expect(broken.log.closed).toBe(1)
  })

  it('aims at the shared upload limit by default', async () => {
    const { codec, log } = fakeCodec()
    const file = fileOf(MAX_UPLOAD_BYTES, 'image/jpeg')
    expect(await shrinkPhoto(file, codec)).toBe(file)
    expect(log.decoded).toBe(0)
  })
})
