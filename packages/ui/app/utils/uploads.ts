import { MAX_UPLOAD_BYTES } from '@hajj/contracts/constants/documents'
import { localeTag } from './format'

/** Why the API would refuse a file (its own error codes), checked before sending it — the API checks again. */
export type UploadRefusal = 'TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE' | 'EMPTY_FILE'

export function uploadRefusal(file: { type: string, size: number }, allowedTypes: readonly string[]): UploadRefusal | null {
  if (!allowedTypes.includes(file.type)) return 'TYPE_NOT_ALLOWED'
  if (file.size === 0) return 'EMPTY_FILE'
  return file.size > MAX_UPLOAD_BYTES ? 'FILE_TOO_LARGE' : null
}

const KILOBYTE = 1024
const MEGABYTE = KILOBYTE * KILOBYTE

/** A file size for people: "512 B", "24 KB", "3.5 MB" (Western digits in both languages). */
export function formatBytes(bytes: number, locale: string): string {
  const number = (value: number) => new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(value)
  if (bytes < KILOBYTE) return `${number(bytes)} B`
  return bytes < MEGABYTE ? `${number(bytes / KILOBYTE)} KB` : `${number(bytes / MEGABYTE)} MB`
}
