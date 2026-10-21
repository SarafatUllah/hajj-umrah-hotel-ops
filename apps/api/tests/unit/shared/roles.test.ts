import { describe, expect, it } from 'vitest'
import { DEMO_ONLY_PERMISSIONS, PERMISSIONS } from '../../../shared/constants/permissions'
import { ROLE_DEFINITIONS } from '../../../shared/constants/roles'

describe('role definitions', () => {
  it('seeds the seven demo personas', () => {
    expect(Object.keys(ROLE_DEFINITIONS).sort()).toEqual([
      'ACCOUNTANT', 'HOTEL_MANAGER', 'HR_MANAGER', 'READ_ONLY_MANAGEMENT',
      'RECEPTION', 'RESERVATION_MANAGER', 'SUPER_ADMIN',
    ])
  })

  it('grants the Super Admin role every permission except the demo-only ones', () => {
    const expected = PERMISSIONS.filter(p => !(DEMO_ONLY_PERMISSIONS as readonly string[]).includes(p))
    expect(ROLE_DEFINITIONS.SUPER_ADMIN.permissions.slice().sort()).toEqual(expected.slice().sort())
  })

  it('never grants a demo-only permission to any role definition (least privilege)', () => {
    for (const [key, definition] of Object.entries(ROLE_DEFINITIONS)) {
      for (const demoOnly of DEMO_ONLY_PERMISSIONS) {
        expect(definition.permissions, `${key} must not hold demo-only permission ${demoOnly}`).not.toContain(demoOnly)
      }
    }
  })

  it('only references permissions that exist in the catalog', () => {
    for (const definition of Object.values(ROLE_DEFINITIONS)) {
      for (const permissionKey of definition.permissions) {
        expect(PERMISSIONS).toContain(permissionKey)
      }
    }
  })

  it('gives the Hotel Manager role capacity.manage, room.block and audit.view', () => {
    expect(ROLE_DEFINITIONS.HOTEL_MANAGER.permissions).toEqual(expect.arrayContaining(['capacity.manage', 'room.block', 'audit.view']))
  })

  it('gives the read-only role no mutating permissions', () => {
    const mutating = ROLE_DEFINITIONS.READ_ONLY_MANAGEMENT.permissions.filter(p => !p.endsWith('.view'))
    expect(mutating).toEqual([])
  })
})
