import { describe, expect, it } from 'vitest'
import type { StaffMe } from '@hajj/contracts/types/staff'
import { accessOf } from '../app/utils/access'

const me = (over: Partial<StaffMe>): StaffMe => ({
  user: { userId: 'u', organizationId: 'o', email: 'a@b.test', fullName: 'A' },
  organization: { id: 'o', name: 'Org', slug: 'demo', isDemo: true },
  roles: [],
  permissions: [],
  allHotels: false,
  hotelIds: [],
  twoFactorEnrollmentRequired: false,
  ...over,
})

describe('what the signed-in staff member may do (§34)', () => {
  it('a permission of the role counts in a hotel only with access to that hotel', () => {
    const access = accessOf(me({ permissions: ['room.view', 'room.manage'], hotelIds: ['h1'] }))
    expect(access.can('room.manage')).toBe(true)
    expect(access.can('hotel.manage')).toBe(false)
    expect(access.canInHotel('room.manage', 'h1')).toBe(true)
    expect(access.canInHotel('room.manage', 'h2')).toBe(false)
    expect(access.hasAllHotels).toBe(false)
  })

  it('all-hotels access reaches every hotel; nobody signed in may do nothing', () => {
    const access = accessOf(me({ permissions: ['room.view'], allHotels: true }))
    expect(access.canInHotel('room.view', 'any')).toBe(true)
    expect(access.canInHotel('room.manage', 'any')).toBe(false)
    const none = accessOf(null)
    expect(none.can('room.view')).toBe(false)
    expect(none.canInHotel('room.view', 'h1')).toBe(false)
  })
})
