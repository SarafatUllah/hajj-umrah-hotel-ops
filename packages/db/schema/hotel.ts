import { sql } from 'drizzle-orm'
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, time, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { appUser, organization } from './tenancy'

export const hotel = pgTable('hotel', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  country: text('country').notNull().default('SA'),
  address: text('address'),
  phone: text('phone'),
  email: text('email'),
  timezone: text('timezone').notNull().default('Asia/Riyadh'),
  currency: text('currency').notNull().default('SAR'),
  checkInTime: time('check_in_time').notNull().default('15:00'),
  checkOutTime: time('check_out_time').notNull().default('12:00'),
  licenseReference: text('license_reference'),
  ownershipType: text('ownership_type').notNull().default('OWNED'),
  status: text('status').notNull().default('ACTIVE'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('hotel_org_id_unique').on(t.organizationId, t.id),
  unique('hotel_org_code_unique').on(t.organizationId, t.code),
  check('hotel_status_check', sql`${t.status} in ('ACTIVE', 'INACTIVE')`),
  check('hotel_ownership_check', sql`${t.ownershipType} in ('OWNED', 'LEASED', 'CONTRACTED')`),
  check('hotel_currency_check', sql`char_length(${t.currency}) = 3`),
])

export const hotelSetting = pgTable('hotel_setting', {
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  hotelId: uuid('hotel_id').notNull(),
  key: text('key').notNull(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  // organization_id leads the primary key (not just hotel_id, key) so the ON CONFLICT DO UPDATE
  // target used by HotelSettingRepository.upsert can never match another organization's row that
  // happens to share the same (hotel_id, key) — the conflict identity is itself tenant-scoped.
  primaryKey({ columns: [t.organizationId, t.hotelId, t.key] }),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'hotel_setting_hotel_fk' }),
  // PF-6: covers both the direct organization_id FK (above, via references()) and the composite
  // (organization_id, hotel_id) FK (leftmost-prefix rule — organization_id is this index's first column).
  index('hotel_setting_org_hotel_idx').on(t.organizationId, t.hotelId),
])

export const userHotelAccess = pgTable('user_hotel_access', {
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  hotelId: uuid('hotel_id').notNull(),
  grantedBy: uuid('granted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.userId, t.hotelId] }),
  foreignKey({ columns: [t.organizationId, t.userId], foreignColumns: [appUser.organizationId, appUser.id], name: 'user_hotel_access_user_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.organizationId, t.hotelId], foreignColumns: [hotel.organizationId, hotel.id], name: 'user_hotel_access_hotel_fk' }),
  // PF-6: two distinct composite FKs above need their own leading-column coverage.
  index('user_hotel_access_hotel_idx').on(t.organizationId, t.hotelId),
  index('user_hotel_access_user_idx').on(t.organizationId, t.userId),
])
