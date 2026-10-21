import { describe, expect, it } from 'vitest'
import { canChangeAgencyStatus, normalizeLicenseNo } from '../../../server/domain/accounts/agencyRules'

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
