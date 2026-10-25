import { Readable } from 'node:stream'
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, NoSuchKey, NotFound, PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStorageDriver } from '../../../server/storage'
import { createS3Client, S3StorageDriver, type S3StorageConfig } from '../../../server/storage/s3StorageDriver'
import { InvalidStorageKeyError, StorageObjectExistsError, StorageObjectNotFoundError } from '../../../server/storage/storageDriver'

const BUCKET = 'hotel-files'
const KEY = '11111111-1111-1111-1111-111111111111/2026/abc-123.pdf'
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])

const metadata = (status: number) => ({ $metadata: { httpStatusCode: status } })
const accessDenied = () => new S3ServiceException({ name: 'AccessDenied', $fault: 'client', message: 'Access Denied', ...metadata(403) })

interface SentCommand { command: string, input: Record<string, unknown> }

/** An in-memory bucket answering the four commands the driver sends, the way S3 does (404s as typed errors). */
class FakeBucket {
  readonly objects = new Map<string, Buffer>()
  readonly sent: SentCommand[] = []
  /** When set, every command fails with this error. */
  failure: unknown = null

  async send(command: unknown): Promise<unknown> {
    const { input } = command as { input: { Bucket: string, Key: string, Body?: Uint8Array } }
    this.sent.push({ command: (command as object).constructor.name, input: input as unknown as Record<string, unknown> })
    if (this.failure) throw this.failure
    const stored = this.objects.get(`${input.Bucket}/${input.Key}`)
    if (command instanceof HeadObjectCommand) {
      if (!stored) throw new NotFound({ message: 'NotFound', ...metadata(404) })
      return { ContentLength: stored.length }
    }
    if (command instanceof GetObjectCommand) {
      if (!stored) throw new NoSuchKey({ message: 'The specified key does not exist.', ...metadata(404) })
      return { Body: Readable.from([stored]) }
    }
    if (command instanceof PutObjectCommand) {
      this.objects.set(`${input.Bucket}/${input.Key}`, Buffer.from(input.Body!))
      return {}
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(`${input.Bucket}/${input.Key}`)
      return {}
    }
    throw new Error(`unexpected command ${(command as object).constructor.name}`)
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

describe('S3StorageDriver', () => {
  let bucket: FakeBucket
  let driver: S3StorageDriver
  beforeEach(() => {
    bucket = new FakeBucket()
    driver = new S3StorageDriver(bucket, BUCKET)
  })

  it('stores, reads, checks existence and deletes by key, always in the configured bucket', async () => {
    await driver.put(KEY, pdf)
    expect(await driver.exists(KEY)).toBe(true)
    expect(await readAll(await driver.get(KEY))).toEqual(Buffer.from(pdf))
    await driver.delete(KEY)
    expect(await driver.exists(KEY)).toBe(false)
    expect(bucket.sent.every(sent => sent.input.Bucket === BUCKET && sent.input.Key === KEY)).toBe(true)
  })

  it('uploads the bytes as an opaque object of their exact length', async () => {
    await driver.put(KEY, pdf)
    const put = bucket.sent.find(sent => sent.command === 'PutObjectCommand')
    expect(put?.input).toMatchObject({ ContentLength: pdf.byteLength, ContentType: 'application/octet-stream' })
  })

  it('never overwrites an existing object: the second put is refused before anything is sent', async () => {
    await driver.put(KEY, pdf)
    const putsBefore = bucket.sent.filter(sent => sent.command === 'PutObjectCommand').length
    await expect(driver.put(KEY, png)).rejects.toBeInstanceOf(StorageObjectExistsError)
    expect(bucket.sent.filter(sent => sent.command === 'PutObjectCommand')).toHaveLength(putsBefore)
    expect(await readAll(await driver.get(KEY))).toEqual(Buffer.from(pdf))
  })

  it('reports a missing object cleanly: get -> StorageObjectNotFoundError, exists -> false, delete succeeds', async () => {
    await expect(driver.get(KEY)).rejects.toBeInstanceOf(StorageObjectNotFoundError)
    expect(await driver.exists(KEY)).toBe(false)
    await expect(driver.delete(KEY)).resolves.toBeUndefined()
  })

  it('treats a NoSuchKey answer to a delete as already deleted', async () => {
    bucket.failure = new NoSuchKey({ message: 'The specified key does not exist.', ...metadata(404) })
    await expect(driver.delete(KEY)).resolves.toBeUndefined()
  })

  it('fails closed on any other storage error: no "missing" or "absent" guess', async () => {
    bucket.failure = accessDenied()
    await expect(driver.exists(KEY)).rejects.toThrow('Access Denied')
    await expect(driver.get(KEY)).rejects.toThrow('Access Denied')
    await expect(driver.put(KEY, pdf)).rejects.toThrow('Access Denied')
    await expect(driver.delete(KEY)).rejects.toThrow('Access Denied')
  })

  it('treats a missing bucket as the configuration error it is, never as a missing file', async () => {
    bucket.failure = new S3ServiceException({ name: 'NoSuchBucket', $fault: 'client', message: 'The specified bucket does not exist', ...metadata(404) })
    await expect(driver.get(KEY)).rejects.toThrow('bucket does not exist')
    await expect(driver.delete(KEY)).rejects.toThrow('bucket does not exist')
  })

  it('refuses keys outside the server-generated grammar without sending anything', async () => {
    for (const bad of ['../evil.pdf', 'a/../../evil.pdf', '/etc/passwd.pdf', 'a//b.pdf', 'a b.pdf', 'a\\b.pdf', 'noext', '', 'a/b\u0000.pdf']) {
      await expect(driver.put(bad, pdf)).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(driver.exists(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(driver.get(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError)
      await expect(driver.delete(bad)).rejects.toBeInstanceOf(InvalidStorageKeyError)
    }
    expect(bucket.sent).toEqual([])
  })
})

const S3_CONFIG: S3StorageConfig = {
  endpoint: 'https://project.storage.example.com/storage/v1/s3',
  region: 'ap-south-1',
  bucket: BUCKET,
  accessKeyId: 'key-id',
  secretAccessKey: 'secret',
  forcePathStyle: true,
}

describe('createS3Client', () => {
  it('points the client at the configured endpoint and region, path-style as asked', async () => {
    const client = createS3Client(S3_CONFIG)
    expect(await client.config.region()).toBe('ap-south-1')
    expect(client.config.forcePathStyle).toBe(true)
    const endpoint = await client.config.endpoint!()
    expect(`${endpoint.protocol}//${endpoint.hostname}${endpoint.path}`).toBe('https://project.storage.example.com/storage/v1/s3')
    expect(await client.config.credentials()).toMatchObject({ accessKeyId: 'key-id', secretAccessKey: 'secret' })
  })

  it('sends checksums only when an operation requires them (S3-compatible stores reject the SDK default ones)', async () => {
    const client = createS3Client(S3_CONFIG)
    expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED')
    expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED')
  })

  interface CapturedRequest { hostname: string, path: string, headers: Record<string, string> }

  /** The signed HTTP request the client would send for `command`, captured by a stand-in handler instead of sent. */
  async function signedRequest(config: S3StorageConfig, command: HeadObjectCommand): Promise<CapturedRequest> {
    const client = createS3Client(config)
    let captured: CapturedRequest | undefined
    Object.assign(client.config, {
      requestHandler: {
        handle: async (request: CapturedRequest) => {
          captured = request
          throw new Error('captured')
        },
      },
    })
    await expect(client.send(command)).rejects.toThrow('captured')
    return captured!
  }

  // The two stores the deploy guide names (docs/DEPLOY_VERCEL.md), with the settings it gives for each.
  it.each([
    {
      store: 'Cloudflare R2',
      config: { ...S3_CONFIG, endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', region: 'auto' },
      hostname: '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      path: `/${BUCKET}/${KEY}`,
    },
    {
      store: 'Supabase Storage',
      config: { ...S3_CONFIG, endpoint: 'https://abcdefghijklmnop.storage.supabase.co/storage/v1/s3', region: 'ap-south-1' },
      hostname: 'abcdefghijklmnop.storage.supabase.co',
      path: `/storage/v1/s3/${BUCKET}/${KEY}`,
    },
  ])('addresses $store as it expects: its endpoint, the bucket in the path, signed for its region', async ({ config, hostname, path }) => {
    const request = await signedRequest(config, new HeadObjectCommand({ Bucket: BUCKET, Key: KEY }))
    expect(request.hostname).toBe(hostname)
    expect(request.path).toBe(path)
    expect(request.headers.authorization).toMatch(new RegExp(`Credential=key-id/\\d{8}/${config.region}/s3/aws4_request`))
  })
})

describe('createStorageDriver (s3)', () => {
  it('builds the S3 driver from its settings', () => {
    expect(createStorageDriver({ driver: 's3', localDir: '.data/uploads', s3: S3_CONFIG })).toBeInstanceOf(S3StorageDriver)
  })

  it('refuses the s3 driver without its settings', () => {
    expect(() => createStorageDriver({ driver: 's3', localDir: '.data/uploads' })).toThrow(/S3/)
  })
})
