import { PERMISSIONS, type Permission } from './permissions'

export interface RoleDefinition {
  name: string
  permissions: Permission[]
}

export const ROLE_DEFINITIONS: Record<string, RoleDefinition> = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    permissions: [...PERMISSIONS],
  },
  HOTEL_MANAGER: {
    name: 'Hotel Manager',
    permissions: [
      'hotel.view', 'hotel.manage', 'room.view', 'room.manage',
      'booking.view', 'booking.create', 'booking.edit', 'booking.cancel', 'booking.override',
      'rate.view', 'rate.manage', 'payment.view', 'payment.create',
      'expense.view', 'expense.create',
      'employee.view', 'employee.manage',
      'payroll.view',
      'compliance.view', 'compliance.manage',
      'report.view', 'report.export',
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
