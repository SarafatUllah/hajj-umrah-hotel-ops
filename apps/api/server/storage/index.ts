import { randomUUID } from 'node:crypto'
import { getStorageEnv } from '../utils/env'
import { LocalStorageDriver, type StorageDriver } from './localStorageDriver'

export { InvalidStorageKeyError, isValidStorageKey, LocalStorageDriver, StorageObjectNotFoundError, type StorageDriver } from './localStorageDriver'
export { MAX_UPLOAD_BYTES, sanitizeFilename, UploadRejectedError, validateUpload, type AllowedMime, type UploadRejection, type ValidatedUpload } from './uploadValidation'

export class UnsupportedStorageDriverError extends Error {
  constructor(driver: string) {
    super(`Unsupported STORAGE_DRIVER ${JSON.stringify(driver)} (supported: "local")`)
    this.name = 'UnsupportedStorageDriverError'
  }
}

export interface StorageConfig { driver: string, localDir: string }

/**
 * The driver factory. An unknown driver name throws — it never silently falls back to local disk
 * (the env schema rejects it first; this is the second, independent guard).
 */
export function createStorageDriver(config: StorageConfig): StorageDriver {
  if (config.driver === 'local') return new LocalStorageDriver(config.localDir)
  throw new UnsupportedStorageDriverError(config.driver)
}

let cached: StorageDriver | null = null

/** The process-wide driver, built once from the validated environment (`STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`). */
export function getStorageDriver(): StorageDriver {
  if (cached) return cached
  const env = getStorageEnv()
  cached = createStorageDriver({ driver: env.STORAGE_DRIVER, localDir: env.STORAGE_LOCAL_DIR })
  return cached
}

export function resetStorageDriverCache(): void {
  cached = null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `<organizationId>/<year>/<random uuid><ext>`: built ONLY from the (trusted) organization id, the
 * clock and a random uuid. The user's filename, MIME string and bytes never contribute to it.
 */
export function generateStorageKey(organizationId: string, extension: string, now: Date = new Date()): string {
  if (!UUID.test(organizationId)) throw new Error('Storage keys are scoped by a valid organization id')
  if (!/^\.[a-z0-9]{2,5}$/.test(extension)) throw new Error('Invalid storage key extension')
  return `${organizationId}/${now.getUTCFullYear()}/${randomUUID()}${extension}`
}
