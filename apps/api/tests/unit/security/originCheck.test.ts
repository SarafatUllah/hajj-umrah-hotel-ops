import { describe, expect, it } from 'vitest'
import { isRefusedCrossSiteRequest, type OriginCheckRequest } from '../../../server/security/originCheck'

const base: OriginCheckRequest = {
  method: 'POST',
  path: '/api/hotels',
  origin: undefined,
  secFetchSite: undefined,
  host: 'ops.example.com',
  allowedOrigins: [],
}
const refused = (overrides: Partial<OriginCheckRequest>) => isRefusedCrossSiteRequest({ ...base, ...overrides })

describe('isRefusedCrossSiteRequest', () => {
  it('never refuses safe methods or paths outside /api/', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(refused({ method, origin: 'https://evil.example' })).toBe(false)
    expect(refused({ path: '/login', origin: 'https://evil.example' })).toBe(false)
  })

  it('accepts an Origin on the request host (scheme-agnostic, case-insensitive host)', () => {
    expect(refused({ origin: 'https://ops.example.com' })).toBe(false)
    expect(refused({ origin: 'http://ops.example.com', host: 'OPS.example.com' })).toBe(false)
    expect(refused({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' })).toBe(false)
  })

  it('refuses a foreign, malformed or null Origin on every unsafe method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) expect(refused({ method, origin: 'https://evil.example' })).toBe(true)
    expect(refused({ origin: 'null' })).toBe(true)
    expect(refused({ origin: 'not a url' })).toBe(true)
    expect(refused({ origin: 'ftp://ops.example.com' })).toBe(true)
    expect(refused({ origin: 'https://ops.example.com.evil.example' })).toBe(true)
    expect(refused({ origin: 'http://127.0.0.1:4000', host: '127.0.0.1:3000' })).toBe(true)
  })

  it('accepts exactly the ALLOWED_ORIGINS entries besides the request host', () => {
    const allowedOrigins = ['https://agency.example.com']
    expect(refused({ origin: 'https://agency.example.com', allowedOrigins })).toBe(false)
    expect(refused({ origin: 'https://ops.example.com', allowedOrigins })).toBe(false)
    expect(refused({ origin: 'http://agency.example.com', allowedOrigins })).toBe(true)
  })

  it('without an Origin: refuses only a browser request marked cross-site', () => {
    expect(refused({ secFetchSite: 'cross-site' })).toBe(true)
    expect(refused({ secFetchSite: 'same-site' })).toBe(false)
    expect(refused({ secFetchSite: 'same-origin' })).toBe(false)
    expect(refused({ secFetchSite: 'none' })).toBe(false)
    expect(refused({})).toBe(false)
  })

  it('an allowed Origin wins over Sec-Fetch-Site: cross-site (frontends on another site)', () => {
    expect(refused({ origin: 'https://agency.example.org', secFetchSite: 'cross-site', allowedOrigins: ['https://agency.example.org'] })).toBe(false)
  })
})
