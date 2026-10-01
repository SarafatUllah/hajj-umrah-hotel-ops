/**
 * Every action `recordAudit` (server/services/audit.ts) is allowed to write. A `const` tuple so the
 * union type below is exhaustive; the `audit_log.action` column itself stays plain `text` (no DB
 * enum) so a later Phase can add actions without a migration.
 */
export const AUDIT_ACTIONS = [
  'HOTEL_CREATED',
  'HOTEL_UPDATED',
  'HOTEL_DEACTIVATED',
  'HOTEL_ACTIVATED',
  'HOTEL_SETTINGS_CHANGED',
  'USER_HOTEL_ACCESS_CHANGED',
  'FLOOR_CREATED',
  'FLOOR_UPDATED',
  'ROOM_TYPE_CREATED',
  'ROOM_TYPE_UPDATED',
  'ROOM_CREATED',
  'ROOM_UPDATED',
  'ROOM_BASE_CHANGED',
  'ROOM_RETIRED',
  'ROOM_REACTIVATED',
  'CAPACITY_PERIOD_CREATED',
  'CAPACITY_PERIOD_UPDATED',
  'CAPACITY_PERIOD_DELETED',
  'CAPACITY_OVERRIDES_APPLIED',
  'CAPACITY_OVERRIDE_DELETED',
  'CAPACITY_OVERRIDES_REMOVED',
  'BLOCK_CREATED',
  'BLOCK_CANCELLED',
  'BLOCK_ENDED_EARLY',
  'DOCUMENT_ADDED',
  'DOCUMENT_ARCHIVED',
  'DEMO_RESET',
] as const

export type AuditAction = typeof AUDIT_ACTIONS[number]
