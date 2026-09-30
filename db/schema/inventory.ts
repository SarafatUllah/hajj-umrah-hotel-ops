import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
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
