import { Readable } from 'node:stream'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { assertValidStorageKey, StorageObjectExistsError, StorageObjectNotFoundError, type StorageDriver } from './storageDriver'

/** Where an S3-compatible store is (AWS S3, Cloudflare R2, Supabase Storage, MinIO …) and the credentials to use it. */
export interface S3StorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key` (Supabase Storage and MinIO need it). */
  forcePathStyle: boolean
}

/** The one method of the S3 client the driver uses (a fake in tests). */
export interface S3CommandSender {
  send(command: unknown): Promise<unknown>
}

/** A slow or unreachable store fails the request instead of holding it: connecting, then each answer. */
const CONNECTION_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 30_000

export function createS3Client(config: S3StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // The SDK's default extra checksums are refused by several S3-compatible stores; send them only when S3 requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  })
}

/**
 * S3 answers a missing object with a typed 404 (`NoSuchKey` on GET, `NotFound` on HEAD); any other failure is real — a
 * missing bucket above all (`NoSuchBucket`, also a 404), which is a configuration error, not an absent file. A HEAD
 * answer has no body to name it, so `exists` reads a missing bucket as an absent key; `put` then fails on its write and
 * `get` on its read, so the error still surfaces.
 */
function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown, $metadata?: { httpStatusCode?: unknown } } | null
  if (candidate?.name === 'NoSuchBucket') return false
  return candidate?.name === 'NoSuchKey' || candidate?.name === 'NotFound' || candidate?.$metadata?.httpStatusCode === 404
}

/**
 * Objects in one private bucket of an S3-compatible store (ARCHITECTURE §15), under the same server-generated keys as
 * the local driver. Nothing here is public: bytes only ever leave through the API (passport images are already
 * encrypted before they reach any driver).
 */
export class S3StorageDriver implements StorageDriver {
  constructor(private readonly client: S3CommandSender, private readonly bucket: string) {}

  /**
   * Never overwrites: S3-compatible stores do not all honour a conditional write (Supabase Storage documents none), so
   * the key is checked first. Keys hold a random uuid, so the gap between the check and the write is not a real race.
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertValidStorageKey(key)
    if (await this.exists(key)) throw new StorageObjectExistsError()
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentLength: bytes.byteLength, ContentType: 'application/octet-stream' }))
  }

  async get(key: string): Promise<Readable> {
    assertValidStorageKey(key)
    let response: { Body?: unknown }
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })) as { Body?: unknown }
    }
    catch (error) {
      if (isNotFound(error)) throw new StorageObjectNotFoundError()
      throw error
    }
    // In Node the SDK hands back the response as a Readable stream.
    if (!(response.Body instanceof Readable)) throw new Error('The storage returned no readable body')
    return response.Body
  }

  async exists(key: string): Promise<boolean> {
    assertValidStorageKey(key)
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    }
    catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    assertValidStorageKey(key)
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    }
    catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}
