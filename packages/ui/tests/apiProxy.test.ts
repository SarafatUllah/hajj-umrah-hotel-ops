import { describe, expect, it } from 'vitest'
import { bodyRefusal, forwardablePath, MAX_PROXIED_BODY_BYTES, proxyTargetUrl, visitorAddress } from '../server/utils/apiProxy'

const allow = ['/api/public/', '/api/customer/']

describe('the frontends\' API proxy', () => {
  it('forwards only the app\'s own prefixes, and nothing that could climb out of them', () => {
    expect(forwardablePath('/api/customer/bookings?page=2', allow)).toBe('/api/customer/bookings?page=2')
    expect(forwardablePath('/api/public/hotels?organization=demo', allow)).toBe('/api/public/hotels?organization=demo')
    expect(forwardablePath('/api/agency/auth/me', allow)).toBeNull()
    expect(forwardablePath('/api/auth/login', allow)).toBeNull()
    for (const sneaky of ['/api/customer/../agency/auth/me', '/api/customer/%2e%2e/agency', '/api/customer/%2E%2E/x', '/api/customer/..%5cagency', '/api/customer\\..\\agency', '/api/customer/\t../x']) {
      expect(forwardablePath(sneaky, allow)).toBeNull()
    }
  })

  it('a prefix without a trailing slash is a whole resource: itself, below it or its query — never a longer name', () => {
    const staff = ['/api/hotels', '/api/bookings']
    expect(forwardablePath('/api/hotels', staff)).toBe('/api/hotels')
    expect(forwardablePath('/api/hotels?status=ACTIVE', staff)).toBe('/api/hotels?status=ACTIVE')
    expect(forwardablePath('/api/hotels/abc/rooms', staff)).toBe('/api/hotels/abc/rooms')
    expect(forwardablePath('/api/hotels-export', staff)).toBeNull()
    expect(forwardablePath('/api/bookingsX', staff)).toBeNull()
  })

  it('the visitor\'s address is the connection\'s, or the nearest trusted hop — never one the visitor typed', () => {
    expect(visitorAddress('6.6.6.6', '203.0.113.9', false)).toBe('203.0.113.9')
    expect(visitorAddress('6.6.6.6, 198.51.100.7', '10.0.0.2', true)).toBe('198.51.100.7')
    expect(visitorAddress(undefined, '10.0.0.2', true)).toBe('10.0.0.2')
    expect(visitorAddress(undefined, undefined, false)).toBe('unknown')
  })

  it('a body is refused before it is read when its declared length is over the largest upload, or a chunked one has none', () => {
    expect(bodyRefusal(undefined, undefined)).toBeNull()
    expect(bodyRefusal(String(MAX_PROXIED_BODY_BYTES), undefined)).toBeNull()
    expect(bodyRefusal(String(MAX_PROXIED_BODY_BYTES + 1), undefined)).toEqual({ statusCode: 413, code: 'BODY_TOO_LARGE' })
    expect(bodyRefusal(undefined, 'chunked')).toEqual({ statusCode: 411, code: 'LENGTH_REQUIRED' })
  })
})

describe('proxyTargetUrl', () => {
  it('appends the forwarded path to the API origin', () => {
    expect(proxyTargetUrl('http://localhost:3100', '/api/public/hotels?organization=demo')).toBe('http://localhost:3100/api/public/hotels?organization=demo')
  })

  it('joins a base that ends in a slash or carries a path (a host-generated service URL) without doubling the slash', () => {
    expect(proxyTargetUrl('https://api.internal/', '/api/customer/me')).toBe('https://api.internal/api/customer/me')
    expect(proxyTargetUrl('https://edge.internal/svc/api//', '/api/customer/me')).toBe('https://edge.internal/svc/api/api/customer/me')
  })
})
