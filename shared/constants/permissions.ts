export const PERMISSIONS = [
  'hotel.view',
  'hotel.manage',
  'room.view',
  'room.manage',
  'capacity.manage',
  'room.block',
  'booking.view',
  'booking.create',
  'booking.edit',
  'booking.cancel',
  'booking.override',
  'rate.view',
  'rate.manage',
  'payment.view',
  'payment.create',
  'expense.view',
  'expense.create',
  'expense.approve',
  'employee.view',
  'employee.viewSensitive',
  'employee.manage',
  'payroll.view',
  'payroll.manage',
  'compliance.view',
  'compliance.manage',
  'report.view',
  'report.export',
  'user.manage',
  'audit.view',
  'organization.resetDemo',
] as const

export type Permission = typeof PERMISSIONS[number]

/**
 * Permissions that exist only to support the demo organization's self-service reset. Never granted
 * generically by a role definition (see ROLE_DEFINITIONS.SUPER_ADMIN) — only the demo organization's
 * seed grants them explicitly (db/seed/rbac.ts, db/seed/demo-org.ts), so a Super Admin of any other
 * (real) tenant never holds the power to wipe another organization's data.
 */
export const DEMO_ONLY_PERMISSIONS = ['organization.resetDemo'] as const

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'hotel.view': 'View hotel details and settings',
  'hotel.manage': 'Create and edit hotels',
  'room.view': 'View rooms and room types',
  'room.manage': 'Create and edit rooms, room types, and capacity periods',
  'capacity.manage': 'Change base capacity and manage seasonal capacity periods and overrides',
  'room.block': 'Create and cancel operational blocks, maintenance and out-of-service periods',
  'booking.view': 'View bookings',
  'booking.create': 'Create new bookings and holds',
  'booking.edit': 'Edit existing bookings',
  'booking.cancel': 'Cancel bookings',
  'booking.override': 'Override system-suggested room allocation and confirm partial allocations',
  'rate.view': 'View rate plans and pricing',
  'rate.manage': 'Create and edit rate plans',
  'payment.view': 'View payments and invoices',
  'payment.create': 'Record payments and issue receipts',
  'expense.view': 'View expenses',
  'expense.create': 'Create expenses',
  'expense.approve': 'Approve expenses above threshold',
  'employee.view': 'View employee records (non-sensitive fields)',
  'employee.viewSensitive': 'View sensitive employee fields (Iqama, passport, salary)',
  'employee.manage': 'Create and edit employee records',
  'payroll.view': 'View payroll runs',
  'payroll.manage': 'Create and process payroll runs',
  'compliance.view': 'View compliance documents',
  'compliance.manage': 'Create, renew, and manage compliance documents',
  'report.view': 'View reports and dashboards',
  'report.export': 'Export reports as PDF/Excel',
  'user.manage': 'Manage users, roles, and hotel access assignments',
  'audit.view': 'View the audit log for hotels the user can access',
  'organization.resetDemo': 'Reset the demo organization to its seeded baseline',
}
