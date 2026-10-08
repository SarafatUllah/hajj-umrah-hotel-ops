import { DEMO_ONLY_PERMISSIONS, PERMISSIONS, type Permission } from './permissions'

export interface RoleDefinition {
  name: string
  permissions: Permission[]
}

const DEMO_ONLY = new Set<string>(DEMO_ONLY_PERMISSIONS)

export const ROLE_DEFINITIONS: Record<string, RoleDefinition> = {
  // Every permission except the demo-only ones (least privilege, PF-2): organization.resetDemo is
  // granted only to the demo organization's SUPER_ADMIN role, explicitly, by the seed
  // (db/seed/demo-org.ts) — never generically to every organization's Super Admin.
  SUPER_ADMIN: {
    name: 'Super Admin',
    permissions: PERMISSIONS.filter(p => !DEMO_ONLY.has(p)),
  },
  HOTEL_MANAGER: {
    name: 'Hotel Manager',
    permissions: [
      'hotel.view', 'hotel.manage', 'room.view', 'room.manage', 'capacity.manage', 'room.block',
      'booking.view', 'booking.create', 'booking.edit', 'booking.cancel', 'booking.override',
      'rate.view', 'rate.manage', 'payment.view', 'payment.create',
      'expense.view', 'expense.create',
      'employee.view', 'employee.manage',
      'payroll.view',
      'compliance.view', 'compliance.manage',
      'report.view', 'report.export',
      'audit.view',
    ],
  },
  RESERVATION_MANAGER: {
    name: 'Reservation Manager',
    permissions: [
      'hotel.view', 'room.view',
      'booking.view', 'booking.create', 'booking.edit', 'booking.cancel',
      'rate.view', 'payment.view', 'payment.create',
      'report.view',
    ],
  },
  ACCOUNTANT: {
    name: 'Accountant',
    permissions: [
      'hotel.view', 'booking.view',
      'rate.view', 'rate.manage',
      'payment.view', 'payment.create',
      'expense.view', 'expense.create', 'expense.approve',
      'payroll.view', 'payroll.manage',
      'report.view', 'report.export',
    ],
  },
  HR_MANAGER: {
    name: 'HR Manager',
    permissions: [
      'hotel.view',
      'employee.view', 'employee.viewSensitive', 'employee.manage',
      'payroll.view', 'payroll.manage',
      'compliance.view', 'compliance.manage',
      'report.view',
    ],
  },
  RECEPTION: {
    name: 'Reception',
    permissions: [
      'hotel.view', 'room.view',
      'booking.view', 'booking.create', 'booking.edit',
      'payment.view', 'payment.create',
    ],
  },
  READ_ONLY_MANAGEMENT: {
    name: 'Read-only Management',
    permissions: [
      'hotel.view', 'room.view', 'booking.view', 'rate.view', 'payment.view',
      'expense.view', 'employee.view', 'payroll.view', 'compliance.view', 'report.view',
    ],
  },
}
