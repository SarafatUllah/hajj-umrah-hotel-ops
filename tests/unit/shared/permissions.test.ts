import { describe, expect, it } from 'vitest'
import { DEMO_ONLY_PERMISSIONS, PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../../../shared/constants/permissions'

const SPEC_REQUIRED_PERMISSIONS = [
  'hotel.view', 'room.view', 'room.manage', 'capacity.manage', 'room.block',
  'booking.view', 'booking.create', 'booking.edit', 'booking.cancel', 'booking.override',
  'rate.view', 'rate.manage', 'payment.view', 'payment.create',
  'expense.view', 'expense.create', 'expense.approve',
  'employee.view', 'employee.manage', 'payroll.view', 'payroll.manage',
  'compliance.view', 'compliance.manage', 'report.view', 'report.export',
  'user.manage', 'audit.view',
]

describe('permission catalog', () => {
  it('includes every permission required by the spec', () => {
    for (const key of SPEC_REQUIRED_PERMISSIONS) {
      expect(PERMISSIONS).toContain(key)
    }
  })

  it('has no duplicate permission keys', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length)
  })

  it('uses lowercase-dot-namespaced keys', () => {
    for (const key of PERMISSIONS) {
      expect(key).toMatch(/^[a-z]+\.[a-zA-Z]+$/)
    }
  })

  it('has a description for every permission', () => {
    for (const key of PERMISSIONS) {
      expect(PERMISSION_DESCRIPTIONS[key]).toBeTruthy()
    }
  })

  it('lists organization.resetDemo as demo-only, and demo-only permissions are still in the catalog', () => {
    expect(DEMO_ONLY_PERMISSIONS).toEqual(['organization.resetDemo'])
    for (const key of DEMO_ONLY_PERMISSIONS) {
      expect(PERMISSIONS).toContain(key)
    }
  })
})
