import { randomUUID } from 'node:crypto'
import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { beforeAll, describe, expect, it } from 'vitest'
import { createS3Client, S3StorageDriver, type S3StorageConfig } from '../../../server/storage/s3StorageDriver'
import { StorageObjectExistsError, StorageObjectNotFoundError } from '../../../server/storage/storageDriver'

/**
 * The S3 driver against a real S3-compatible store. Opt-in (CI has none): set S3_TEST_ENDPOINT, S3_TEST_ACCESS_KEY_ID
 * and S3_TEST_SECRET_ACCESS_KEY (S3_TEST_BUCKET, S3_TEST_REGION optional), e.g. for a local SeaweedFS (any keys):
 *   docker run -d -p 127.0.0.1:9100:8333 chrislusf/seaweedfs server -s3
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9100 S3_TEST_ACCESS_KEY_ID=any S3_TEST_SECRET_ACCESS_KEY=any pnpm test:integration
 * The first write to a fresh store can take seconds (it allocates its volumes): hence the longer timeout.
 */
const endpoint = process.env.S3_TEST_ENDPOINT

describe.skipIf(!endpoint)('S3StorageDriver against a real S3-compatible store', { timeout: 30_000 }, () => {
  const config: S3StorageConfig = {
    endpoint: endpoint ?? '',
    region: process.env.S3_TEST_REGION ?? 'us-east-1',
    bucket: process.env.S3_TEST_BUCKET ?? 'hajj-driver-test',
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: true,
  }
  const client = createS3Client(config)
  const driver = new S3StorageDriver(client, config.bucket)
  const keyOf = () => `11111111-1111-1111-1111-111111111111/2026/${randomUUID()}.pdf`
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

  beforeAll(async () => {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket })).catch(() => client.send(new CreateBucketCommand({ Bucket: config.bucket })))
  })

  async function read(key: string): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of await driver.get(key)) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  }

  it('stores, reads, checks existence and deletes an object', async () => {
    const key = keyOf()
    await driver.put(key, pdf)
    expect(await driver.exists(key)).toBe(true)
    expect(await read(key)).toEqual(Buffer.from(pdf))
    await driver.delete(key)
    expect(await driver.exists(key)).toBe(false)
  })

  it('refuses to overwrite, reports a missing object, deletes idempotently', async () => {
    const key = keyOf()
    await driver.put(key, pdf)
    await expect(driver.put(key, new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(StorageObjectExistsError)
    expect(await read(key)).toEqual(Buffer.from(pdf))
    await driver.delete(key)
    await expect(driver.get(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError)
    await expect(driver.delete(key)).resolves.toBeUndefined()
  })

  it('reports a missing bucket as an error, not as a missing file', async () => {
    const elsewhere = new S3StorageDriver(client, `missing-${randomUUID().slice(0, 8)}`)
    await expect(elsewhere.get(keyOf())).rejects.not.toBeInstanceOf(StorageObjectNotFoundError)
  })
})
