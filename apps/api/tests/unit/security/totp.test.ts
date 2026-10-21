import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, generateTotpSecret, totpCodeAt, totpStepAt, totpUri, verifyTotp } from '../../../server/security/totp'

// RFC 6238 Appendix B, SHA1 seed "12345678901234567890" (the 6-digit code is the last 6 of the 8-digit vector).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))
const vectors: Array<[number, string]> = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]

describe('TOTP (RFC 6238)', () => {
  it('base32 round-trips and matches the RFC seed encoding', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890')
    expect(() => base32Decode('not-base32!')).toThrow(/Invalid base32/)
  })

  it.each(vectors)('matches the RFC vector at T=%i', (seconds, code) => {
    expect(totpCodeAt(RFC_SECRET, totpStepAt(new Date(seconds * 1000)))).toBe(code)
  })

  it('accepts the current step and one step of skew, nothing further', () => {
    const now = new Date(1_700_000_000_000)
    const step = totpStepAt(now)
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step), now)).toEqual({ ok: true, step })
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 1), now)).toEqual({ ok: true, step: step - 1 })
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step + 1), now)).toEqual({ ok: true, step: step + 1 })
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 2), now)).toEqual({ ok: false })
  })

  it('never accepts a step at or before the last used one (replay)', () => {
    const now = new Date(1_700_000_000_000)
    const step = totpStepAt(now)
    const code = totpCodeAt(RFC_SECRET, step)
    expect(verifyTotp(RFC_SECRET, code, now, step)).toEqual({ ok: false })
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toEqual({ ok: true, step })
  })

  it('rejects malformed codes', () => {
    const now = new Date()
    expect(verifyTotp(RFC_SECRET, '12345', now)).toEqual({ ok: false })
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toEqual({ ok: false })
  })

  it('generates 160-bit secrets and an authenticator URI', () => {
    const secret = generateTotpSecret()
    expect(base32Decode(secret)).toHaveLength(20)
    const uri = totpUri({ secret, issuer: 'Hajj Ops', account: 'admin@example.test' })
    expect(uri).toMatch(/^otpauth:\/\/totp\/Hajj%20Ops%3Aadmin%40example\.test\?secret=[A-Z2-7]+&issuer=Hajj\+Ops&algorithm=SHA1&digits=6&period=30$/)
  })
})
