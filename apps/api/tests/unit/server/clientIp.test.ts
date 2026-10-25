import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const envState = { TRUST_PROXY: false, TRUST_VISITOR_HEADER: false }
vi.mock('../../../server/utils/env', () => ({ getEnv: () => envState }))

const { clientIp, rateLimitAddress } = await import('../../../server/utils/clientIp')

const eventWith = (headers: Record<string, string>, remoteAddress?: string) =>
  ({ node: { req: { headers, socket: { remoteAddress } } } }) as unknown as H3Event

describe('clientIp', () => {
  beforeEach(() => {
    envState.TRUST_PROXY = false
    envState.TRUST_VISITOR_HEADER = false
  })

  it('uses the socket address and ignores X-Forwarded-For without TRUST_PROXY', () => {
    expect(clientIp(eventWith({ 'x-forwarded-for': '198.51.100.1' }, '10.0.0.5'))).toBe('10.0.0.5')
  })

  it('with TRUST_PROXY uses the LAST X-Forwarded-For entry (the one our proxy appended), never a client-sent one', () => {
    envState.TRUST_PROXY = true
    expect(clientIp(eventWith({ 'x-forwarded-for': '6.6.6.6, 198.51.100.1' }, '10.0.0.5'))).toBe('198.51.100.1')
    expect(clientIp(eventWith({ 'x-forwarded-for': '198.51.100.1' }, '10.0.0.5'))).toBe('198.51.100.1')
  })

  it('falls back to the socket address, then to "unknown"', () => {
    envState.TRUST_PROXY = true
    expect(clientIp(eventWith({}, '10.0.0.5'))).toBe('10.0.0.5')
    expect(clientIp(eventWith({}))).toBe('unknown')
  })

  it('with TRUST_VISITOR_HEADER uses the address the frontends\' proxy put in x-hajj-visitor-ip, before X-Forwarded-For', () => {
    Object.assign(envState, { TRUST_PROXY: true, TRUST_VISITOR_HEADER: true })
    // A hop between the proxy and the API (a Vercel service binding) may have rewritten X-Forwarded-For.
    expect(clientIp(eventWith({ 'x-hajj-visitor-ip': '198.51.100.7', 'x-forwarded-for': '76.76.21.9' }, '10.0.0.5'))).toBe('198.51.100.7')
    expect(clientIp(eventWith({ 'x-hajj-visitor-ip': '2001:db8:85a3:42::9' }))).toBe('2001:db8:85a3:42::/64')
  })

  it('without TRUST_VISITOR_HEADER ignores x-hajj-visitor-ip, so a client reaching the API directly cannot pick its address', () => {
    envState.TRUST_PROXY = true
    expect(clientIp(eventWith({ 'x-hajj-visitor-ip': '6.6.6.6', 'x-forwarded-for': '198.51.100.7' }, '10.0.0.5'))).toBe('198.51.100.7')
  })

  it('falls back to X-Forwarded-For, then the socket, when the visitor header is missing or not an address', () => {
    Object.assign(envState, { TRUST_PROXY: true, TRUST_VISITOR_HEADER: true })
    expect(clientIp(eventWith({ 'x-forwarded-for': '198.51.100.7' }, '10.0.0.5'))).toBe('198.51.100.7')
    expect(clientIp(eventWith({ 'x-hajj-visitor-ip': 'unknown', 'x-forwarded-for': '198.51.100.7' }, '10.0.0.5'))).toBe('198.51.100.7')
    envState.TRUST_PROXY = false
    expect(clientIp(eventWith({ 'x-hajj-visitor-ip': 'not an address' }, '10.0.0.5'))).toBe('10.0.0.5')
  })
})

describe('rateLimitAddress', () => {
  it('keeps IPv4 as is and unwraps IPv4-mapped IPv6', () => {
    expect(rateLimitAddress('203.0.113.7')).toBe('203.0.113.7')
    expect(rateLimitAddress('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(rateLimitAddress('::FFFF:203.0.113.7')).toBe('203.0.113.7')
  })

  it('groups IPv6 by /64, whatever the notation (compressed, zero-padded, upper-case, zone id)', () => {
    const prefix = '2001:db8:85a3:42::/64'
    expect(rateLimitAddress('2001:db8:85a3:42::1')).toBe(prefix)
    expect(rateLimitAddress('2001:0db8:85a3:0042:ffff:1:2:3')).toBe(prefix)
    expect(rateLimitAddress('2001:DB8:85A3:42:0:0:0:9')).toBe(prefix)
    expect(rateLimitAddress('2001:db8:85a3:42::1%eth0')).toBe(prefix)
    expect(rateLimitAddress('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(rateLimitAddress('::1')).toBe('0:0:0:0::/64')
  })

  it('leaves anything that is not an IP address untouched', () => {
    expect(rateLimitAddress('unknown')).toBe('unknown')
  })

  it('clientIp applies the grouping to both sources', () => {
    envState.TRUST_PROXY = true
    expect(clientIp(eventWith({ 'x-forwarded-for': '6.6.6.6, 2001:db8:85a3:42::9' }))).toBe('2001:db8:85a3:42::/64')
    envState.TRUST_PROXY = false
    expect(clientIp(eventWith({}, '::ffff:10.0.0.5'))).toBe('10.0.0.5')
  })
})
