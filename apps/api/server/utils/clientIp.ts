import { isIP } from 'node:net'
import type { H3Event } from 'h3'
import { getRequestHeader } from 'h3'
import { VISITOR_ADDRESS_HEADER } from '@hajj/contracts/constants/proxy'
import { getEnv } from './env'

/** The eight hextets of an IPv6 address (`::` expanded, zone id dropped), lower-case without leading zeros. */
function ipv6Groups(address: string): string[] {
  const [head = '', tail] = address.split('%')[0]!.split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const zeros = tail === undefined ? [] : Array.from({ length: Math.max(0, 8 - headGroups.length - tailGroups.length) }, () => '0')
  return [...headGroups, ...zeros, ...tailGroups].map(group => (/^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16).toString(16) : group))
}

/**
 * The rate-limit subject of a client address: an IPv4-mapped IPv6 address becomes its IPv4 form, and IPv6
 * addresses are grouped by their /64 prefix (one subscriber usually owns a whole /64, so a per-address limit
 * would be meaningless for them).
 */
export function rateLimitAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped) return mapped[1]!
  if (isIP(address.split('%')[0]!) !== 6) return address
  return `${ipv6Groups(address).slice(0, 4).join(':')}::/64`
}

/**
 * The client address for rate limiting. With TRUST_VISITOR_HEADER=true (the API reachable only through the
 * frontends' proxy) it is the address that proxy put in its own header, when that is an address. Then, with
 * TRUST_PROXY=true (exactly ONE reverse proxy in front of the API, and the API reachable only through it), the
 * LAST `X-Forwarded-For` entry — the one our proxy appended; earlier entries are whatever the client sent and are
 * never trusted. Otherwise the socket address.
 */
export function clientIp(event: H3Event): string {
  const env = getEnv()
  if (env.TRUST_VISITOR_HEADER) {
    const visitor = getRequestHeader(event, VISITOR_ADDRESS_HEADER)?.trim()
    if (visitor && isIP(visitor.split('%')[0]!) !== 0) return rateLimitAddress(visitor)
  }
  if (env.TRUST_PROXY) {
    const forwarded = getRequestHeader(event, 'x-forwarded-for')?.split(',').map(part => part.trim()).filter(Boolean)
    const last = forwarded?.at(-1)
    if (last) return rateLimitAddress(last)
  }
  const socketAddress = event.node.req.socket?.remoteAddress
  return socketAddress ? rateLimitAddress(socketAddress) : 'unknown'
}
