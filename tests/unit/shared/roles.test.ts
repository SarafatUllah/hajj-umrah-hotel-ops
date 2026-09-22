import { describe, expect, it } from 'vitest'
import { PERMISSIONS } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'

describe('role definitions', () => {
  it('seeds the seven demo personas', () => {
    expect(Object.keys(ROLE_DEFINITIONS).sort()).toEqual([
      'ACCOUNTANT', 'HOTEL_MANAGER', 'HR_MANAGER', 'READ_ONLY_MANAGEMENT',
      'RECEPTION', 'RESERVATION_MANAGER', 'SUPER_ADMIN',
    ])
  })

  it('grants the Super Admin role every permission', () => {
    expect(ROLE_DEFINITIONS.SUPER_ADMIN.permissions.slice().sort()).toEqual([...PERMISSIONS].sort())
  })

  it('only references permissions that exist in the catalog', () => {
    for (const definition of Object.values(ROLE_DEFINITIONS)) {
      for (const permissionKey of definition.permissions) {
        expect(PERMISSIONS).toContain(permissionKey)
      }
    }
  })

  it('gives the read-only role no mutating permissions', () => {
    const mutating = ROLE_DEFINITIONS.READ_ONLY_MANAGEMENT.permissions.filter(p => !p.endsWith('.view'))
    expect(mutating).toEqual([])
  })
})
