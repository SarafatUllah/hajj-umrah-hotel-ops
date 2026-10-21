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
  // PF-21: the bulk-block summary row (entityType 'hotel', entityId = hotelId), written once per bulk
  // request alongside one BLOCK_CREATED row per block.
  'BLOCKS_BULK_CREATED',
  'DOCUMENT_ADDED',
  'DOCUMENT_ARCHIVED',
  'DEMO_RESET',
  // Staff two-factor authentication (entityType 'app_user', entityId = the user's id).
  'TWO_FACTOR_SETUP_STARTED',
  'TWO_FACTOR_ENABLED',
  'TWO_FACTOR_DISABLED',
  // An administrator removed another user's second factor (lost device); `reason` says why.
  'TWO_FACTOR_RESET',
  // Agency accounts (entityType 'agency' / 'agency_user'); a self-registration has no staff actor.
  'AGENCY_REGISTERED',
  'AGENCY_CREATED',
  'AGENCY_STATUS_CHANGED',
  'AGENCY_USER_CREATED',
  'AGENCY_USER_UPDATED',
  // Booking rules (entityType rate / agency_quota / allocation_rule / extra_bed_policy) and settings.
  'BOOKING_RULE_CREATED',
  'BOOKING_RULE_UPDATED',
  'BOOKING_RULE_DELETED',
  'BOOKING_SETTINGS_CHANGED',
] as const

export type AuditAction = typeof AUDIT_ACTIONS[number]
