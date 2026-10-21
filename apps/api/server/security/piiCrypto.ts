import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Application-level encryption for personal data (design v7 §13 "পাসপোর্টের তথ্যের সুরক্ষা (PDPL)"):
 * passport numbers, guest details, passport images, TOTP secrets.
 *
 * - AES-256-GCM with a random 96-bit IV per value and a 128-bit tag (tampering is detected).
 * - Every value is bound to a `context` (e.g. `app_user.totp_secret`) as additional authenticated data,
 *   so a ciphertext copied into another column or record type fails to decrypt.
 * - A key ring: the first key encrypts, every key decrypts (rotation = prepend a new key, re-encrypt
 *   at leisure, then drop the old one). A KMS-backed ring can replace the environment one later without
 *   changing callers.
 * - `blindIndex` is a keyed HMAC-SHA256 (separate key) for equality lookups on encrypted values
 *   (`passport_lookup`); it cannot be reversed without the lookup key.
 */
export interface PiiKey { id: string, key: Buffer }
export type KeyRing = readonly [PiiKey, ...PiiKey[]]

export interface PiiCipher {
  encrypt(plaintext: string, context: string): string
  decrypt(token: string, context: string): string
  encryptBytes(data: Uint8Array, context: string): Buffer
  decryptBytes(blob: Uint8Array, context: string): Buffer
  blindIndex(value: string, context: string): string
}

export class PiiDecryptionError extends Error {
  constructor(reason: string) {
    super(`PII value could not be decrypted: ${reason}`)
    this.name = 'PiiDecryptionError'
  }
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const TOKEN_PREFIX = 'pii1'
const BLOB_MAGIC = Buffer.from('PII1', 'ascii')
const KEY_ID = /^[a-z0-9]{1,16}$/

/** Parses `id:base64key[,id:base64key…]` (first = current). Each key must decode to exactly 32 bytes. */
export function parseKeyRing(spec: string): KeyRing {
  const keys = spec.split(',').map(part => part.trim()).filter(Boolean).map((part): PiiKey => {
    const separator = part.indexOf(':')
    const id = separator > 0 ? part.slice(0, separator) : ''
    if (!KEY_ID.test(id)) throw new Error('PII key ids must be 1-16 lowercase letters or digits ("id:base64key")')
    const key = Buffer.from(part.slice(separator + 1), 'base64')
    if (key.length !== KEY_BYTES) throw new Error(`PII key "${id}" must be ${KEY_BYTES} bytes (base64)`)
    return { id, key }
  })
  if (keys.length === 0) throw new Error('PII key ring is empty')
  if (new Set(keys.map(k => k.id)).size !== keys.length) throw new Error('PII key ids must be unique')
  return keys as unknown as KeyRing
}

/** Parses the blind-index key (base64, at least 32 bytes). */
export function parseLookupKey(spec: string): Buffer {
  const key = Buffer.from(spec.trim(), 'base64')
  if (key.length < KEY_BYTES) throw new Error(`PII lookup key must be at least ${KEY_BYTES} bytes (base64)`)
  return key
}

export function createPiiCipher(ring: KeyRing, lookupKey: Buffer): PiiCipher {
  const current = ring[0]
  const byId = new Map(ring.map(k => [k.id, k.key]))
  const keyFor = (id: string): Buffer => {
    const key = byId.get(id)
    if (!key) throw new PiiDecryptionError(`unknown key id "${id}"`)
    return key
  }

  const seal = (data: Uint8Array, context: string) => {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(Buffer.from(context, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
    return { keyId: current.id, iv, ciphertext, tag: cipher.getAuthTag() }
  }

  const open = (keyId: string, iv: Buffer, ciphertext: Buffer, tag: Buffer, context: string): Buffer => {
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new PiiDecryptionError('malformed value')
    try {
      const decipher = createDecipheriv(ALGORITHM, keyFor(keyId), iv, { authTagLength: TAG_BYTES })
      decipher.setAAD(Buffer.from(context, 'utf8'))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()])
    }
    catch (error) {
      if (error instanceof PiiDecryptionError) throw error
      throw new PiiDecryptionError('authentication failed (wrong key, wrong context or tampered value)')
    }
  }

  return {
    encrypt(plaintext, context) {
      const { keyId, iv, ciphertext, tag } = seal(Buffer.from(plaintext, 'utf8'), context)
      return [TOKEN_PREFIX, keyId, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.')
    },

    decrypt(token, context) {
      const parts = token.split('.')
      if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX) throw new PiiDecryptionError('not a PII token')
      const [, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string]
      return open(keyId, Buffer.from(iv, 'base64url'), Buffer.from(ciphertext, 'base64url'), Buffer.from(tag, 'base64url'), context).toString('utf8')
    },

    encryptBytes(data, context) {
      const { keyId, iv, ciphertext, tag } = seal(data, context)
      const id = Buffer.from(keyId, 'ascii')
      return Buffer.concat([BLOB_MAGIC, Buffer.from([id.length]), id, iv, tag, ciphertext])
    },

    decryptBytes(blob, context) {
      const buf = Buffer.from(blob)
      if (buf.length < BLOB_MAGIC.length + 1 || !timingSafeEqual(buf.subarray(0, BLOB_MAGIC.length), BLOB_MAGIC)) throw new PiiDecryptionError('not a PII blob')
      const idLength = buf[BLOB_MAGIC.length]!
      let offset = BLOB_MAGIC.length + 1
      const keyId = buf.subarray(offset, offset += idLength).toString('ascii')
      const iv = buf.subarray(offset, offset += IV_BYTES)
      const tag = buf.subarray(offset, offset += TAG_BYTES)
      return open(keyId, iv, buf.subarray(offset), tag, context)
    },

    blindIndex(value, context) {
      return createHmac('sha256', lookupKey).update(context, 'utf8').update('\u0000').update(value, 'utf8').digest('hex')
    },
  }
}
