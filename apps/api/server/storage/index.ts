import { randomUUID } from 'node:crypto'
import { getStorageEnv, type StorageEnv } from '../utils/env'
import { LocalStorageDriver } from './localStorageDriver'
import { createS3Client, S3StorageDriver, type S3StorageConfig } from './s3StorageDriver'
import type { StorageDriver } from './storageDriver'

export { LocalStorageDriver } from './localStorageDriver'
export { S3StorageDriver, type S3StorageConfig } from './s3StorageDriver'
export { InvalidStorageKeyError, isValidStorageKey, StorageObjectExistsError, StorageObjectNotFoundError, type StorageDriver } from './storageDriver'
export { imageSize, type ImageSize } from './imageSize'
export { MAX_UPLOAD_BYTES, sanitizeFilename, UploadRejectedError, validateUpload, type AllowedMime, type UploadRejection, type ValidatedUpload } from './uploadValidation'

export class UnsupportedStorageDriverError extends Error {
  constructor(driver: string) {
    super(`Unsupported STORAGE_DRIVER ${JSON.stringify(driver)} (supported: "local", "s3")`)
    this.name = 'UnsupportedStorageDriverError'
  }
}

export interface StorageConfig { driver: string, localDir: string, s3?: S3StorageConfig }

/**
 * The driver factory. An unknown driver name throws — it never silently falls back to local disk
 * (the env schema rejects it first; this is the second, independent guard).
 */
export function createStorageDriver(config: StorageConfig): StorageDriver {
  if (config.driver === 'local') return new LocalStorageDriver(config.localDir)
  if (config.driver === 's3') {
    if (!config.s3) throw new Error('STORAGE_DRIVER=s3 needs its S3_* settings')
    return new S3StorageDriver(createS3Client(config.s3), config.s3.bucket)
  }
  throw new UnsupportedStorageDriverError(config.driver)
}

/** The S3 settings from the validated environment (the schema guarantees them all when the driver is `s3`). */
function s3ConfigOf(env: StorageEnv): S3StorageConfig | undefined {
  if (env.STORAGE_DRIVER !== 's3') return undefined
  return {
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION!,
    bucket: env.S3_BUCKET!,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  }
}

let cached: StorageDriver | null = null

/** The process-wide driver, built once from the validated environment (`STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`, `S3_*`). */
export function getStorageDriver(): StorageDriver {
  if (cached) return cached
  const env = getStorageEnv()
  cached = createStorageDriver({ driver: env.STORAGE_DRIVER, localDir: env.STORAGE_LOCAL_DIR, s3: s3ConfigOf(env) })
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
