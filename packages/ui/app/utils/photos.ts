import { MAX_UPLOAD_BYTES } from '@hajj/contracts/constants/documents'

/** Longest side a shrunk photo keeps: a passport's machine-readable lines stay sharp at it (9 megapixels at most). */
export const PHOTO_MAX_EDGE_PX = 3000
/** JPEG qualities tried in turn until the photo fits the upload limit. */
const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6] as const
/** Photos the browser can redraw; anything else (a PDF) is sent as it is. */
const SHRINKABLE_TYPES: readonly string[] = ['image/jpeg', 'image/png']

export interface PhotoSize { width: number, height: number }

/** A photo the browser has read, upright: drawn again at a size and quality on demand, released with `close`. */
export interface DecodedPhoto {
  size: PhotoSize
  toJpeg(size: PhotoSize, quality: number): Promise<Blob>
  close(): void
}

export interface PhotoCodec {
  /** The photo, or null when the browser cannot read it. */
  decode(file: Blob): Promise<DecodedPhoto | null>
}

/** `size` scaled so its longest side is at most `maxEdge` — never enlarged, never a side of zero. */
export function fitWithin(size: PhotoSize, maxEdge: number): PhotoSize {
  const scale = Math.min(1, maxEdge / Math.max(size.width, size.height))
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

const jpegName = (name: string) => `${name.replace(/\.(?:png|jpe?g)$/i, '')}.jpg`

/**
 * A photo over the upload limit (D-P2-67: 4 MB, what a serverless host accepts in one request), redrawn smaller as a
 * JPEG; any other file comes back untouched. When no version fits, or the browser cannot draw the photo, the original
 * comes back and the size check before sending says why it was refused — never a silent loss of the file.
 */
export async function shrinkPhoto(file: File, codec: PhotoCodec = browserCodec, limit: number = MAX_UPLOAD_BYTES): Promise<File> {
  if (file.size <= limit || !SHRINKABLE_TYPES.includes(file.type)) return file
  const photo = await codec.decode(file).catch(() => null)
  if (!photo) return file
  try {
    const size = fitWithin(photo.size, PHOTO_MAX_EDGE_PX)
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await photo.toJpeg(size, quality)
      if (jpeg.size <= limit) return new File([jpeg], jpegName(file.name), { type: 'image/jpeg', lastModified: file.lastModified })
    }
    return file
  }
  catch {
    return file
  }
  finally {
    photo.close()
  }
}

/** The browser's own decoder (EXIF rotation applied) and a canvas; a transparent PNG is drawn on white, not black. */
const browserCodec: PhotoCodec = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null)
    if (!bitmap) return null
    return {
      size: { width: bitmap.width, height: bitmap.height },
      toJpeg: (size, quality) => drawJpeg(bitmap, size, quality),
      close: () => bitmap.close(),
    }
  },
}

function drawJpeg(bitmap: ImageBitmap, size: PhotoSize, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) return Promise.reject(new Error('The browser gave no 2D canvas'))
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The browser could not encode the photo'))), 'image/jpeg', quality)
  })
}
