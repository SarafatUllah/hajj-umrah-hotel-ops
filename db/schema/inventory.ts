import { sql } from 'drizzle-orm'
import { boolean, check, date, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { hotel } from './hotel'
import { organization } from './tenancy'

const orgCol = () => uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' })
const stamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const floor = pgTable('floor', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  level: integer('level').notNull(),
  label: text('label').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...stamps(),
}, t => [
  unique('floor_org_hotel_id_unique').on(t.organizationId, t.hotelId, t.id),
  unique('floor_hotel_level_unique').on(t.hotelId, t.level),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'floor_hotel_fk' }),
  check('floor_level_check', sql`${t.level} between -5 and 200`),
])

export const roomType = pgTable('room_type', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  defaultPhysicalBeds: integer('default_physical_beds').notNull(),
  defaultSellableCapacity: integer('default_sellable_capacity').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...stamps(),
}, t => [
  unique('room_type_org_id_unique').on(t.organizationId, t.id),
  unique('room_type_org_code_unique').on(t.organizationId, t.code),
  check('room_type_beds_check', sql`${t.defaultPhysicalBeds} between 1 and 30`),
  check('room_type_sellable_check', sql`${t.defaultSellableCapacity} between 0 and 30`),
])

/**
 * Task 14: physical rooms. There is deliberately NO `status` column — lifecycle (in-service /
 * retired), base/effective capacity, and "next change" are all DERIVED from `room_base_config`'s
 * versioned history (server/domain/inventory/{capacity,calendar,baseVersions,nextChange}.ts), never
 * stored as a flag. `room_number` is unique per hotel for the room's entire lifetime and immutable
 * after creation (D16) — enforced structurally by `room_hotel_number_unique` below (no soft-delete,
 * no status column, so a number can never be "freed up" for reuse).
 */
export const room = pgTable('room', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  floorId: uuid('floor_id').notNull(),
  roomTypeId: uuid('room_type_id').notNull(),
  roomNumber: text('room_number').notNull(),
  features: text('features').array().notNull().default(sql`'{}'::text[]`),
  notes: text('notes'),
  ...stamps(),
}, t => [
  unique('room_org_hotel_id_unique').on(t.organizationId, t.hotelId, t.id),
  unique('room_hotel_number_unique').on(t.hotelId, t.roomNumber),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'room_hotel_fk' }),
  foreignKey({ columns: [t.organizationId, t.hotelId, t.floorId], foreignColumns: [floor.organizationId, floor.hotelId, floor.id], name: 'room_floor_fk' }),
  foreignKey({ columns: [t.organizationId, t.roomTypeId], foreignColumns: [roomType.organizationId, roomType.id], name: 'room_type_fk' }),
  index('room_hotel_floor_idx').on(t.organizationId, t.hotelId, t.floorId),
  index('room_type_idx').on(t.organizationId, t.roomTypeId),
  check('room_number_check', sql`char_length(btrim(${t.roomNumber})) between 1 and 20`),
])

/**
 * Task 14: a room's versioned base (physical/sellable) capacity history. Rows are never mutated once
 * closed — a base change / retire / reactivate only ever closes the currently-open version's
 * `valid_to` or inserts a brand-new open-ended version (server/domain/inventory/baseVersions.ts).
 * The temporal-integrity exclusion constraint (no two versions of the same room may have overlapping
 * `[valid_from, valid_to]` ranges) is appended by hand to migration 0004 after `drizzle-kit generate`
 * (Drizzle has no first-class `EXCLUDE USING gist` builder).
 */
export const roomBaseConfig = pgTable('room_base_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: orgCol(),
  hotelId: uuid('hotel_id').notNull(),
  roomId: uuid('room_id').notNull(),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  physicalBeds: integer('physical_beds').notNull(),
  sellableCapacity: integer('sellable_capacity').notNull(),
  origin: text('origin').notNull().default('MANUAL'),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.hotelId, t.roomId], foreignColumns: [room.organizationId, room.hotelId, room.id], name: 'room_base_config_room_fk' }),
  index('room_base_config_org_hotel_idx').on(t.organizationId, t.hotelId),
  // PF-6: the brief's verbatim block only indexes (organization_id, hotel_id) — added here so the
  // FULL 3-column room_base_config_room_fk (organization_id, hotel_id, room_id) is covered by an
  // index's leading columns too (the global "every FK column set gets an index" rule), on top of the
  // org_hotel index above which already serves whole-hotel range queries.
  index('room_base_config_room_idx').on(t.organizationId, t.hotelId, t.roomId),
  check('room_base_config_range_check', sql`${t.validTo} is null or ${t.validFrom} <= ${t.validTo}`),
  check('room_base_config_beds_check', sql`${t.physicalBeds} between 1 and 30`),
  check('room_base_config_sellable_check', sql`${t.sellableCapacity} between 0 and 30`),
  check('room_base_config_origin_check', sql`${t.origin} in ('ROOM_TYPE_DEFAULT', 'MANUAL', 'BULK', 'SEED')`),
])
