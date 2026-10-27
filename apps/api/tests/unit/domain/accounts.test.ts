import { describe, expect, it } from 'vitest'
import { canChangeAgencyStatus, normalizeLicenseNo } from '../../../server/domain/accounts/agencyRules'
import { emailLimitSubject, verifiedEmailOf } from '../../../server/domain/accounts/customerRules'

describe('agency rules', () => {
  it('normalizes licence numbers for comparison', () => {
    expect(normalizeLicenseNo('  abc-1 ')).toBe('ABC-1')
  })

  it('allows only the reviewed status transitions', () => {
    expect(canChangeAgencyStatus('PENDING', 'APPROVED')).toBe(true)
    expect(canChangeAgencyStatus('PENDING', 'SUSPENDED')).toBe(false)
    expect(canChangeAgencyStatus('APPROVED', 'SUSPENDED')).toBe(true)
    expect(canChangeAgencyStatus('APPROVED', 'REJECTED')).toBe(false)
    expect(canChangeAgencyStatus('SUSPENDED', 'APPROVED')).toBe(true)
    expect(canChangeAgencyStatus('REJECTED', 'APPROVED')).toBe(true)
    expect(canChangeAgencyStatus('REJECTED', 'SUSPENDED')).toBe(false)
  })
})

describe('customer rules (D-P2-68)', () => {
  it('an e-mail address is an identity only once verified', () => {
    expect(verifiedEmailOf({ email: 'aisha@example.com', emailVerifiedAt: new Date() })).toBe('aisha@example.com')
    expect(verifiedEmailOf({ email: 'aisha@example.com', emailVerifiedAt: null })).toBeNull()
    expect(verifiedEmailOf({ email: null, emailVerifiedAt: null })).toBeNull()
  })

  it('the abuse limits count a mailbox once, whatever its aliases: a +tag goes, and Gmail\'s dots and googlemail.com', () => {
    expect(emailLimitSubject('aisha+hajj@example.com')).toBe('aisha@example.com')
    expect(emailLimitSubject('a.i.sha+1@gmail.com')).toBe('aisha@gmail.com')
    expect(emailLimitSubject('aisha@googlemail.com')).toBe('aisha@gmail.com')
    // Elsewhere dots are part of the mailbox; a local part that is only a tag stays as it is.
    expect(emailLimitSubject('a.isha@example.com')).toBe('a.isha@example.com')
    expect(emailLimitSubject('+tag@example.com')).toBe('+tag@example.com')
  })
})
