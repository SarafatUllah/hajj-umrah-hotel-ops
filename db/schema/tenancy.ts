import { pgTable, uuid, text, timestamp, boolean, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core'

export const organization = pgTable('organization', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  isDemo: boolean('is_demo').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('organization_slug_unique').on(table.slug),
])

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('app_user_org_email_unique').on(table.organizationId, table.email),
])

export const role = pgTable('role', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('role_org_key_unique').on(table.organizationId, table.key),
])

export const permission = pgTable('permission', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
})

export const rolePermission = pgTable('role_permission', {
  roleId: uuid('role_id').notNull().references(() => role.id, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull().references(() => permission.key, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.roleId, table.permissionKey] }),
])

export const userRole = pgTable('user_role', {
  userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => role.id, { onDelete: 'cascade' }),
}, table => [
  primaryKey({ columns: [table.userId, table.roleId] }),
])
