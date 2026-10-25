import type { Readable } from 'node:stream'

/** Storage abstraction (ARCHITECTURE §15). The database holds metadata and the key; never the bytes. */
export interface StorageDriver {
  /** Creates the object; never overwrites an existing one (rejects instead). */
  put(key: string, bytes: Uint8Array): Promise<void>
  /** Rejects with `StorageObjectNotFoundError` when the object does not exist. */
  get(key: string): Promise<Readable>
  exists(key: string): Promise<boolean>
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    // The key is echoed (JSON-quoted, so control characters stay visible and harmless) for diagnostics;
    // it is server-generated and never reaches an HTTP response.
    super(`Invalid storage key: ${JSON.stringify(key)}`)
    this.name = 'InvalidStorageKeyError'
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor() {
    super('Storage object not found')
    this.name = 'StorageObjectNotFoundError'
  }
}

/** A put found an object already under its key (keys are random, so this is a bug or a replay — never overwritten). */
export class StorageObjectExistsError extends Error {
  constructor() {
    super('Storage object already exists')
    this.name = 'StorageObjectExistsError'
  }
}

const MAX_KEY_LENGTH = 512
/** A directory segment of a key: ASCII letters, digits, `_` and `-` only (no dots, spaces, separators, NUL). */
const DIR_SEGMENT = /^[A-Za-z0-9_-]+$/
/** The last segment: a name plus exactly one lowercase extension. */
const FILE_SEGMENT = /^[A-Za-z0-9_-]+\.[a-z0-9]{2,5}$/

/** Pure key check, exported for tests: `dir/dir/name.ext` (any number of directories), no empty segments, no dots but the extension's. */
export function isValidStorageKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return false
  const segments = key.split('/')
  const file = segments.pop()!
  return FILE_SEGMENT.test(file) && segments.every(s => DIR_SEGMENT.test(s))
}

/** Every driver refuses a key outside the server-generated grammar before it touches its store. */
export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) throw new InvalidStorageKeyError(key)
}
