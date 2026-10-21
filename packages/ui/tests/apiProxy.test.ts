import { describe, expect, it } from 'vitest'
import { forwardablePath, visitorAddress } from '../server/utils/apiProxy'

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

  it('the visitor\'s address is the connection\'s, or the nearest trusted hop — never one the visitor typed', () => {
    expect(visitorAddress('6.6.6.6', '203.0.113.9', false)).toBe('203.0.113.9')
    expect(visitorAddress('6.6.6.6, 198.51.100.7', '10.0.0.2', true)).toBe('198.51.100.7')
    expect(visitorAddress(undefined, '10.0.0.2', true)).toBe('10.0.0.2')
    expect(visitorAddress(undefined, undefined, false)).toBe('unknown')
  })
})
