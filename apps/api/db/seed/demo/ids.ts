import { createHash } from 'node:crypto'

/** Fixed namespace for every demo id. Random-looking but constant: the same key always yields the same UUID. */
export const DEMO_NAMESPACE = '5b1c2f0e-8f0a-4c67-9d6a-3e1f4a7c9b21'

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

/** RFC 4122 version-5 (SHA-1, name-based) UUID. */
export function uuidV5(name: string, namespace: string): string {
  const hash = createHash('sha1').update(uuidToBytes(namespace)).update(name, 'utf8').digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6]! & 0x0F) | 0x50
  b[8] = (b[8]! & 0x3F) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * The name hashed for a key: every part (the kind included) is written as `<length>:<text>` and the parts
 * are joined, so the encoding is injective whatever characters a part contains —
 * `('a|b', 'c')` and `('a', 'b|c')` can never collide, as a plain separator join would let them.
 */
export function keyName(kind: string, parts: readonly string[]): string {
  return [kind, ...parts].map(part => `${part.length}:${part}`).join('')
}

/** deterministicId('room', 'MKK-GRAND', '401') is identical on every seed, in every environment. */
export function deterministicId(kind: string, ...parts: string[]): string {
  return uuidV5(keyName(kind, parts), DEMO_NAMESPACE)
}

/**
 * Every durable demo identity, by stable key. A reset recreates rows with exactly these ids, so sessions,
 * bookmarks and cached client state survive it.
 */
export const demoIds = {
  organization: (slug: string) => deterministicId('organization', slug),
  role: (roleKey: string) => deterministicId('role', roleKey),
  user: (personaKey: string) => deterministicId('user', personaKey),
  roomType: (code: string) => deterministicId('room-type', code),
  hotel: (hotelCode: string) => deterministicId('hotel', hotelCode),
  floor: (hotelCode: string, level: number) => deterministicId('floor', hotelCode, String(level)),
  room: (hotelCode: string, roomNumber: string) => deterministicId('room', hotelCode, roomNumber),
  baseVersion: (hotelCode: string, roomNumber: string, validFrom: string) => deterministicId('base-version', hotelCode, roomNumber, validFrom),
  period: (hotelCode: string, periodKey: string) => deterministicId('capacity-period', hotelCode, periodKey),
  override: (hotelCode: string, periodKey: string, roomNumber: string) => deterministicId('capacity-override', hotelCode, periodKey, roomNumber),
  block: (hotelCode: string, blockKey: string) => deterministicId('block', hotelCode, blockKey),
}
