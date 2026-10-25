import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createPiiCipher, parseKeyRing, parseLookupKey, PiiDecryptionError } from '../../../server/security/piiCrypto'

const key = () => randomBytes(32).toString('base64')
const lookup = parseLookupKey(randomBytes(32).toString('base64'))
const CTX = 'pilgrim.passport_number'

describe('PII cipher', () => {
  const ring = parseKeyRing(`k2:${key()},k1:${key()}`)
  const cipher = createPiiCipher(ring, lookup)

  it('round-trips text and never repeats a ciphertext (random IV)', () => {
    const a = cipher.encrypt('A12345678', CTX)
    const b = cipher.encrypt('A12345678', CTX)
    expect(a).not.toBe(b)
    expect(a.startsWith('pii1.k2.')).toBe(true)
    expect(cipher.decrypt(a, CTX)).toBe('A12345678')
    expect(cipher.decrypt(b, CTX)).toBe('A12345678')
  })

  it('round-trips bytes (passport images)', () => {
    const image = randomBytes(4096)
    const sealed = cipher.encryptBytes(image, 'passport_scan.image')
    expect(sealed.includes(image)).toBe(false)
    expect(cipher.decryptBytes(sealed, 'passport_scan.image').equals(image)).toBe(true)
  })

  it('rejects a value moved to another context (AAD binding)', () => {
    const token = cipher.encrypt('secret', 'app_user.totp_secret')
    expect(() => cipher.decrypt(token, CTX)).toThrow(PiiDecryptionError)
  })

  it('detects tampering', () => {
    const parts = cipher.encrypt('A12345678', CTX).split('.')
    const ct = Buffer.from(parts[3]!, 'base64url')
    ct[0] = ct[0]! ^ 0xFF
    parts[3] = ct.toString('base64url')
    expect(() => cipher.decrypt(parts.join('.'), CTX)).toThrow(/authentication failed/)
    const blob = cipher.encryptBytes(Buffer.from('image'), 'x')
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0x01
    expect(() => cipher.decryptBytes(blob, 'x')).toThrow(PiiDecryptionError)
  })

  it('rotates: values sealed with an older key still open after a new key is prepended', () => {
    const oldOnly = createPiiCipher(parseKeyRing(`k1:${ring[1]!.key.toString('base64')}`), lookup)
    const sealedWithOld = oldOnly.encrypt('legacy', CTX)
    expect(cipher.decrypt(sealedWithOld, CTX)).toBe('legacy')
    const unknownKey = createPiiCipher(parseKeyRing(`k9:${key()}`), lookup)
    expect(() => unknownKey.decrypt(sealedWithOld, CTX)).toThrow(/unknown key id "k1"/)
  })

  it('refuses non-tokens', () => {
    expect(() => cipher.decrypt('plain text', CTX)).toThrow(/not a PII token/)
    expect(() => cipher.decryptBytes(Buffer.from('nope'), CTX)).toThrow(/not a PII blob/)
  })

  it('blind index is deterministic, context-separated and key-dependent', () => {
    expect(cipher.blindIndex('BGD|A12345678', CTX)).toBe(cipher.blindIndex('BGD|A12345678', CTX))
    expect(cipher.blindIndex('BGD|A12345678', CTX)).not.toBe(cipher.blindIndex('BGD|A12345678', 'other'))
    const otherLookup = createPiiCipher(ring, parseLookupKey(randomBytes(32).toString('base64')))
    expect(otherLookup.blindIndex('BGD|A12345678', CTX)).not.toBe(cipher.blindIndex('BGD|A12345678', CTX))
    expect(cipher.blindIndex('x', CTX)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('key ring parsing', () => {
  it('rejects malformed rings and short keys', () => {
    expect(() => parseKeyRing('')).toThrow(/empty/)
    expect(() => parseKeyRing(`Bad:${key()}`)).toThrow(/lowercase/)
    expect(() => parseKeyRing(`k1:${randomBytes(16).toString('base64')}`)).toThrow(/32 bytes/)
    expect(() => parseKeyRing(`k1:${key()},k1:${key()}`)).toThrow(/unique/)
    expect(() => parseLookupKey(randomBytes(8).toString('base64'))).toThrow(/at least 32/)
  })
})
